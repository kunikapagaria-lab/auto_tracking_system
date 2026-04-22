import os
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
import cv2
import numpy as np
import re
import base64
import sqlite3
from fastapi import FastAPI, File, UploadFile, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from passlib.context import CryptContext
from ultralytics import YOLO

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model paths ──────────────────────────────────────────────────────────────
_DIR = os.path.dirname(__file__)
PLATE_MODEL_PATH = os.path.join(_DIR, '..', 'licence_plate.pt')
DB_PATH = os.path.join(_DIR, 'users.db')

# ── Hashing Setup ────────────────────────────────────────────────────────────
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def get_password_hash(password):
    return pwd_context.hash(password)

def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

# ── Database Setup ───────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            hashed_password TEXT NOT NULL,
            role TEXT NOT NULL
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# ── Pydantic Models ──────────────────────────────────────────────────────────
class UserRegister(BaseModel):
    username: str
    email: str
    password: str
    role: str

class UserLogin(BaseModel):
    email: str
    password: str

# ── Car & Plate models ──────────────────────────────────────────────────────
VEHICLE_CLASSES = [2, 3, 5, 7]

try:
    print("Loading car detection model (yolov8n)...")
    car_model = YOLO("yolov8n.pt")
    print("Car model loaded!")
except Exception as e:
    print(f"Warning: car model failed ({e})")
    car_model = None

try:
    print(f"Loading license plate model from {PLATE_MODEL_PATH}...")
    plate_model = YOLO(PLATE_MODEL_PATH)
    print("Plate model loaded!")
except Exception as e:
    print(f"Error loading plate model: {e}")
    plate_model = None

try:
    from paddleocr import PaddleOCR
    print("Initializing PaddleOCR...")
    ocr_reader = PaddleOCR(use_textline_orientation=True, lang='en', device='cpu', enable_mkldnn=False)
    print("PaddleOCR ready!")
except Exception as e:
    print(f"Warning: PaddleOCR failed ({e})")
    PaddleOCR = None
    ocr_reader = None


# ── OCR pipeline ─────────────────────────────────────────────────────────────

# Step 1: Perspective rectification
def rectify_plate(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(blurred, 50, 150)
    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return cv2.copyMakeBorder(image, 5, 5, 5, 5, cv2.BORDER_REPLICATE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:5]
    plate_contour = None
    for c in contours:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            plate_contour = approx
            break
    if plate_contour is not None:
        pts = plate_contour.reshape(4, 2)
        rect = np.zeros((4, 2), dtype="float32")
        s = pts.sum(axis=1)
        rect[0] = pts[np.argmin(s)]
        rect[2] = pts[np.argmax(s)]
        diff = np.diff(pts, axis=1)
        rect[1] = pts[np.argmin(diff)]
        rect[3] = pts[np.argmax(diff)]
        (tl, tr, br, bl) = rect
        widthA  = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
        widthB  = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
        maxWidth = max(int(widthA), int(widthB))
        heightA = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
        heightB = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
        maxHeight = max(int(heightA), int(heightB))
        dst = np.array([[0, 0], [maxWidth - 1, 0],
                        [maxWidth - 1, maxHeight - 1], [0, maxHeight - 1]], dtype="float32")
        M = cv2.getPerspectiveTransform(rect, dst)
        warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
        pad_h = int(maxHeight * 0.05)
        pad_w = int(maxWidth * 0.05)
        return cv2.copyMakeBorder(warped, pad_h, pad_h, pad_w, pad_w, cv2.BORDER_REPLICATE)
    return cv2.copyMakeBorder(image, 5, 5, 5, 5, cv2.BORDER_REPLICATE)


# Step 2 helper: 8 variants from one image, all 3× upscaled
def _generate_variants(image, prefix):
    gray     = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe2   = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    clahe_img = clahe2.apply(gray)
    bilateral = cv2.bilateralFilter(clahe_img, 11, 17, 17)
    _, otsu   = cv2.threshold(bilateral, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, hc     = cv2.threshold(clahe_img,  0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    b, g, r   = cv2.split(image)
    ev        = cv2.addWeighted(b, 0.5, r, 0.5, 0)
    ev        = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(ev)
    sharp_k   = np.array([[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]])

    raw = {
        f'{prefix}_bilateral':         bilateral,
        f'{prefix}_adaptive_mean':     cv2.adaptiveThreshold(bilateral, 255, cv2.ADAPTIVE_THRESH_MEAN_C,     cv2.THRESH_BINARY, 11, 2),
        f'{prefix}_adaptive_gaussian': cv2.adaptiveThreshold(bilateral, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2),
        f'{prefix}_otsu':              otsu,
        f'{prefix}_inverted':          cv2.bitwise_not(otsu),
        f'{prefix}_sharpened':         cv2.filter2D(clahe_img, -1, sharp_k),
        f'{prefix}_high_contrast':     hc,
        f'{prefix}_ev_optimized':      ev,
    }
    return {k: cv2.resize(v, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC) for k, v in raw.items()}


# Step 2: 16 total variants — 8 from rectified + 8 from raw crop
def preprocess_variants(rectified, raw):
    variants = {}
    variants.update(_generate_variants(rectified, 'rect'))
    variants.update(_generate_variants(raw,       'raw'))
    return variants


# Step 4: domain-specific post-processing (called per candidate)
def postprocess_text(text):
    if text.upper().startswith('IND'):
        text = text[3:]
    text = re.sub(r'[^A-Z0-9]', '', text.upper())
    if len(text) == 11 and text[0] == 'I':
        text = text[1:]

    to_letter = {'0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '4': 'A', '6': 'G'}
    to_digit  = {'O': '0', 'I': '1', 'Z': '2', 'S': '5', 'B': '8', 'A': '4', 'G': '6'}

    corrected = []
    for i, char in enumerate(text):
        # State-specific: WB plates often misread as HB / NB / MB
        if i == 0 and char in ('H', 'N', 'M') and len(text) > 1 and text[1] == 'B':
            corrected.append('W'); continue
        if i == 0 and char in ('H', 'N'):
            corrected.append('W'); continue
        # Letter positions (0,1,4,5): force digits → letters
        if i in (0, 1, 4, 5) and char.isdigit():
            corrected.append(to_letter.get(char, char))
        # Number positions (2,3,6,7,8,9): force letters → digits
        elif i in (2, 3, 6, 7, 8, 9) and char.isalpha():
            corrected.append(to_digit.get(char, char))
        else:
            corrected.append(char)
    return ''.join(corrected)


# Step 3: OCR inference with left-to-right block merging
def run_ocr_multiple(variants, reader):
    candidates = []
    if reader is None:
        return candidates
    for name, img in variants.items():
        img_bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if len(img.shape) == 2 else img
        try:
            results = reader.predict(img_bgr, use_textline_orientation=True)
        except Exception:
            continue
        if not results:
            continue
        res_obj = results[0]
        texts  = res_obj.get('rec_texts', [])
        scores = res_obj.get('rec_scores', [])
        boxes  = res_obj.get('dt_polys', [])
        if not texts:
            continue
        # Sort text blocks strictly left-to-right by x-coordinate of top-left corner
        blocks = sorted(
            [(boxes[i][0][0] if i < len(boxes) and len(boxes[i]) > 0 else 0,
              texts[i], scores[i])
             for i in range(len(texts))],
            key=lambda x: x[0]
        )
        merged_text = ''.join(b[1] for b in blocks)
        avg_conf    = sum(b[2] for b in blocks) / len(blocks)
        candidates.append((merged_text, avg_conf, name))
    return candidates


# Step 5: confidence + regex-based result selection
def select_best_result(candidates):
    patterns = [
        re.compile(r'^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$'),  # 10-char standard
        re.compile(r'^[A-Z]{2}[0-9]{2}[A-Z]{1}[0-9]{4}$'),   # 9-char
        re.compile(r'^[A-Z]{2}[0-9]{2}[0-9]{4}$'),            # 8-char legacy
    ]
    all_preds       = []
    valid_candidates = []

    for text, conf, variant_name in candidates:
        if conf < 0.4:
            continue
        cleaned = postprocess_text(text)
        all_preds.append({'raw': text, 'cleaned': cleaned, 'conf': conf, 'variant': variant_name})
        for p in patterns:
            if p.match(cleaned):
                boost = 0.2 if len(cleaned) == 10 else 0.0
                valid_candidates.append((cleaned, conf + boost))
                break

    if valid_candidates:
        valid_candidates.sort(key=lambda x: x[1], reverse=True)
        best_text, best_conf = valid_candidates[0]
    elif all_preds:
        all_preds.sort(key=lambda x: x['conf'], reverse=True)
        best_text = all_preds[0]['cleaned']
        best_conf = all_preds[0]['conf']
    else:
        best_text, best_conf = '', 0.0

    return best_text, best_conf, all_preds


@app.post("/register")
async def register(user: UserRegister):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Check if user exists
    cursor.execute("SELECT id FROM users WHERE email = ?", (user.email,))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Email already registered")
    
    hashed_pwd = get_password_hash(user.password)
    cursor.execute(
        "INSERT INTO users (username, email, hashed_password, role) VALUES (?, ?, ?, ?)",
        (user.username, user.email, hashed_pwd, user.role)
    )
    conn.commit()
    conn.close()
    return {"message": "User registered successfully"}

@app.post("/login")
async def login(user_data: UserLogin):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("SELECT username, email, hashed_password, role FROM users WHERE email = ?", (user_data.email,))
    user = cursor.fetchone()
    conn.close()
    
    if not user:
        raise HTTPException(status_code=400, detail="Invalid email or password")
    
    username, email, hashed_password, role = user
    if not verify_password(user_data.password, hashed_password):
        raise HTTPException(status_code=400, detail="Invalid email or password")
    
    return {
        "id": "u" + str(email), # Simple proxy for ID
        "username": username,
        "email": email,
        "role": role,
        "name": username # For frontend compatibility
    }

# ── /detect-plate endpoint ────────────────────────────────────────────────────

@app.post("/detect-plate")
async def detect_plate(file: UploadFile = File(...)):
    if plate_model is None:
        return {"error": "Plate model failed to load on server start."}

    log = []

    try:
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return {"error": "Invalid image received"}

        # ── 1. Vehicle detection ──────────────────────────────────────────────
        if car_model is not None:
            car_results = car_model(img, classes=VEHICLE_CLASSES, device='cpu', verbose=False)
            car_boxes = car_results[0].boxes if car_results else []
            vehicle_count = len(car_boxes)
            log.append(f"[CAR] {vehicle_count} vehicle(s) detected by YOLOv8n")
            for box in car_boxes:
                cls_id = int(box.cls[0])
                cls_name = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}.get(cls_id, 'vehicle')
                log.append(f"  → {cls_name}  conf={float(box.conf[0]):.2f}")
        else:
            log.append("[CAR] Car model not loaded, skipping vehicle detection")

        # ── 2. License plate detection ────────────────────────────────────────
        plate_results = plate_model(img, device='cpu', verbose=False)
        plate_boxes = plate_results[0].boxes if plate_results else []

        log.append(f"[PLATE] {len(plate_boxes)} plate(s) detected by licence_plate.pt")

        if len(plate_boxes) == 0:
            return {"found": False, "detection_log": log}

        best_box = max(plate_boxes, key=lambda b: float(b.conf[0]))
        best_conf = float(best_box.conf[0])
        x1, y1, x2, y2 = map(int, best_box.xyxy[0].tolist())

        h, w = img.shape[:2]
        pad_x = int((x2 - x1) * 0.05)
        pad_y = int((y2 - y1) * 0.05)
        px1 = max(0, x1 - pad_x)
        py1 = max(0, y1 - pad_y)
        px2 = min(w, x2 + pad_x)
        py2 = min(h, y2 + pad_y)

        log.append(f"  → Best plate bbox=[{x1},{y1},{x2},{y2}]  conf={best_conf:.2f}")

        plate_roi = img[py1:py2, px1:px2]

        if plate_roi.shape[0] == 0 or plate_roi.shape[1] == 0:
            log.append("[OCR] Plate crop is empty, skipping OCR")
            return {"found": True, "confidence": round(best_conf, 3), "bbox": [x1, y1, x2, y2],
                    "plate_text": None, "ocr_confidence": 0.0, "detection_log": log}

        # ── 3. OCR pipeline ───────────────────────────────────────────────────
        log.append("[OCR] Rectifying plate perspective...")
        rectified = rectify_plate(plate_roi)

        log.append("[OCR] Generating 16 preprocessing variants (8 rectified + 8 raw, 3× upscale each)...")
        variants = preprocess_variants(rectified, plate_roi)

        log.append("[OCR] Running PaddleOCR on all variants...")
        candidates = run_ocr_multiple(variants, ocr_reader)

        log.append(f"[OCR] {len(candidates)} variant(s) returned text:")
        for text, conf, variant_name in candidates:
            cleaned = postprocess_text(text)
            log.append(f"  [{variant_name}] raw='{text}'  cleaned='{cleaned}'  conf={conf:.2f}")

        best_text, best_ocr_conf, all_preds = select_best_result(candidates)

        if best_text:
            log.append(f"[RESULT] ✓ '{best_text}'  ocr_conf={best_ocr_conf:.2f}")
        else:
            log.append("[RESULT] No plate text could be read")

        # ── Encode plate image for display ────────────────────────────────────
        display_img = cv2.resize(plate_roi, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        _, buffer = cv2.imencode('.jpg', display_img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        plate_b64 = base64.b64encode(buffer).decode('utf-8')

        return {
            "found": True,
            "confidence": round(best_conf, 3),
            "bbox": [x1, y1, x2, y2],
            "image_b64": f"data:image/jpeg;base64,{plate_b64}",
            "plate_text": best_text or None,
            "ocr_confidence": round(best_ocr_conf, 3),
            "detection_log": log,
        }

    except Exception as e:
        log.append(f"[ERROR] {e}")
        print(f"Error during inference: {e}")
        return {"error": str(e), "detection_log": log}


# ── RTSP video proxy ──────────────────────────────────────────────────────────

from fastapi.responses import StreamingResponse
import threading
import time

RTSP_URL = os.environ.get("RTSP_URL", "rtsp://admin:admin%401234@192.168.29.101:554/cam/realmonitor?channel=1&subtype=0")

_camera_registry: dict = {}
_camera_registry_lock = threading.Lock()


class VideoCamera:
    def __init__(self, url):
        self.url = url
        self.frame = None
        self.is_running = True
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()
        print(f"--- Threaded Camera Started for: {url} ---")

    def _capture_loop(self):
        # Use TCP for better stability with most cameras
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
        cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        while self.is_running:
            success, frame = cap.read()
            if success:
                with self.lock:
                    self.frame = frame.copy()
            else:
                print("--- RTSP Connection Lost! Attempting Reconnect... ---")
                cap.release()
                time.sleep(2)
                cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    def get_jpeg(self):
        with self.lock:
            if self.frame is None:
                return None
            ret, buffer = cv2.imencode('.jpg', self.frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            return buffer.tobytes() if ret else None


def get_camera(url: str) -> VideoCamera:
    with _camera_registry_lock:
        if url not in _camera_registry:
            _camera_registry[url] = VideoCamera(url)
        return _camera_registry[url]


def gen_frames(url: str):
    camera = get_camera(url)
    print(f"--- New MJPEG Client Connected ({url}) ---")
    while True:
        frame_bytes = camera.get_jpeg()
        if frame_bytes:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        time.sleep(0.03)


@app.get("/video-feed")
async def video_feed(url: str = None):
    return StreamingResponse(
        gen_frames(url or RTSP_URL),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
        }
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
