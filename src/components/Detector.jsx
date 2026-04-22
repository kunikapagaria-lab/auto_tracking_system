import { useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { PlayCircle, Upload, RefreshCw, X } from 'lucide-react';
import { getDominantColors } from '../utils/colorUtils';
import { useShop } from '../context/ShopContext';

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchPlate(imageDataUrl) {
  try {
    const blob = await (await fetch(imageDataUrl)).blob();
    const fd = new FormData();
    fd.append('file', new File([blob], 'cap.jpg', { type: 'image/jpeg' }));
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';
    const r = await fetch(`${apiUrl}/detect-plate`, { method: 'POST', body: fd });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function captureFrame(source, isRTSP) {
  const c = document.createElement('canvas');
  c.width  = isRTSP ? source.naturalWidth  : source.videoWidth;
  c.height = isRTSP ? source.naturalHeight : source.videoHeight;
  c.getContext('2d').drawImage(source, 0, 0);
  return c.toDataURL('image/jpeg', 0.85);
}

function sampleColor(source, bbox, isRTSP) {
  const [x, y, w, h] = bbox;
  const tmp = document.createElement('canvas');
  tmp.width = 90; tmp.height = 90;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  [
    [0.40,0.50],[0.45,0.50],[0.50,0.50],
    [0.55,0.50],[0.60,0.50],[0.45,0.60],[0.55,0.60],
  ].forEach(([rx, ry], i) => {
    try {
      ctx.drawImage(source, x+w*rx, y+h*ry, w*0.12, h*0.12, (i%3)*30, Math.floor(i/3)*30, 30, 30);
    } catch {}
  });
  return getDominantColors(ctx.getImageData(0, 0, 90, 90), 6)[0];
}

function computeIoU(bbox1, bbox2) {
  const [x1, y1, w1, h1] = bbox1;
  const [x2, y2, w2, h2] = bbox2;
  const ix = Math.max(0, Math.min(x1 + w1, x2 + w2) - Math.max(x1, x2));
  const iy = Math.max(0, Math.min(y1 + h1, y2 + h2) - Math.max(y1, y2));
  const inter = ix * iy;
  const union = w1 * h1 + w2 * h2 - inter;
  return union > 0 ? inter / union : 0;
}

let _tid = 1;

// ─── component ──────────────────────────────────────────────────────────────

export default function Detector() {
  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const imageRef     = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef    = useRef(null);
  const requestRef   = useRef(null);

  // detection-loop state (all refs — loop never restarts due to these)
  const frameRef      = useRef(0);
  const trackersRef   = useRef([]);
  const colorCacheRef = useRef({});
  const colorHistRef  = useRef({});
  const preFetchRef   = useRef({});

  // virtual lines (fraction of canvas height)
  const line1Ref  = useRef({ left: 0.35, right: 0.35 });
  const line2Ref  = useRef({ left: 0.65, right: 0.65 });
  const dragging  = useRef(null);
  const dragPart  = useRef(null);

  // React state (UI only)
  const [model,          setModel]         = useState(null);
  const [error,          setError]         = useState(null);
  const [isMonitoring,   setIsMonitoring]  = useState(false);
  const [isRTSP,         setIsRTSP]        = useState(false);
  const [isLooping,      setIsLooping]     = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [selectedExit,   setSelectedExit]  = useState('');

  // Detection queue — replaces single match state
  const [detectionQueue, setDetectionQueue_] = useState([]);
  const queueRef = useRef([]);
  const setDetectionQueue = (updater) => {
    const next = typeof updater === 'function' ? updater(queueRef.current) : updater;
    queueRef.current = next;
    setDetectionQueue_(next);
  };

  const { addVehicle, vehicles, updateVehicleStatus, feedSource, rtspUrl } = useShop();

  const vehiclesRef = useRef(vehicles);
  useEffect(() => { vehiclesRef.current = vehicles; }, [vehicles]);

  // ── load model ──
  useEffect(() => {
    let alive = true;
    tf.ready()
      .then(() => cocoSsd.load({ base: 'lite_mobilenet_v2' }))
      .then(m  => { if (alive) setModel(m); })
      .catch(() => { if (alive) setError('Failed to load AI model'); });
    return () => {
      alive = false;
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // ── auto-start from saved feed preference ──
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!model || !feedSource || autoStartedRef.current || isMonitoring) return;
    autoStartedRef.current = true;
    if (feedSource === 'rtsp') startRTSP();
    else if (feedSource === 'webcam') startWebcam();
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── draggable lines ──
  function toCanvasCoords(e) {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (c.width / r.width),
      (e.clientY - r.top)  * (c.height / r.height),
    ];
  }

  function getLineYAtX(lineObj, x, width, height) {
    const fracX = Math.max(0, Math.min(1, x / width));
    return height * (lineObj.left * (1 - fracX) + lineObj.right * fracX);
  }

  function onMouseDown(e) {
    const c = canvasRef.current; if (!c) return;
    const [x, y] = toCanvasCoords(e);
    const l1Y = getLineYAtX(line1Ref.current, x, c.width, c.height);
    const l2Y = getLineYAtX(line2Ref.current, x, c.width, c.height);
    let target = null;
    if (Math.abs(y - l1Y) < 35) target = 1;
    else if (Math.abs(y - l2Y) < 35) target = 2;
    if (target) {
      dragging.current = target;
      if (x < c.width * 0.25) dragPart.current = 'left';
      else if (x > c.width * 0.75) dragPart.current = 'right';
      else dragPart.current = 'mid';
      e.preventDefault();
    }
  }

  function onMouseMove(e) {
    const c = canvasRef.current; if (!c) return;
    const [x, y] = toCanvasCoords(e);
    if (dragging.current) {
      const targetObj = dragging.current === 1 ? line1Ref.current : line2Ref.current;
      const fracY = Math.max(0.02, Math.min(0.98, y / c.height));
      if (dragPart.current === 'left') {
        targetObj.left = fracY;
      } else if (dragPart.current === 'right') {
        targetObj.right = fracY;
      } else {
        const currYFrac = targetObj.left * (1 - x / c.width) + targetObj.right * (x / c.width);
        const delta = fracY - currYFrac;
        targetObj.left  = Math.max(0.02, Math.min(0.98, targetObj.left  + delta));
        targetObj.right = Math.max(0.02, Math.min(0.98, targetObj.right + delta));
      }
    } else {
      const l1Y = getLineYAtX(line1Ref.current, x, c.width, c.height);
      const l2Y = getLineYAtX(line2Ref.current, x, c.width, c.height);
      c.style.cursor = (Math.abs(y - l1Y) < 35 || Math.abs(y - l2Y) < 35) ? 'pointer' : 'default';
    }
  }
  function onMouseUp() { dragging.current = null; }

  // ── source controls ──
  function handleFileChange(e) {
    const file = e.target.files[0]; if (!file) return;
    if (!file.type.startsWith('video/')) { setError('Please select a valid video file'); return; }
    const url = URL.createObjectURL(file);
    videoRef.current.src = url;
    videoRef.current.onloadedmetadata = () => { setIsMonitoring(true); setIsRTSP(false); setIsVideoPlaying(false); };
  }
  function startRTSP() { stopWebcam(); setIsMonitoring(true); setIsRTSP(true); setIsVideoPlaying(true); }
  async function startWebcam() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      streamRef.current = s;
      videoRef.current.srcObject = s;
      videoRef.current.onloadedmetadata = () => { setIsMonitoring(true); setIsRTSP(false); setIsVideoPlaying(true); videoRef.current.play(); };
    } catch { setError('Failed to access camera'); }
  }
  function stopWebcam() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }
  function toggleMonitoring() {
    if (isMonitoring) {
      setIsMonitoring(false); setIsRTSP(false); setIsVideoPlaying(false); stopWebcam();
      if (videoRef.current) { videoRef.current.pause(); videoRef.current.src = ''; }
    } else fileInputRef.current.click();
  }

  // ── detection loop ──
  useEffect(() => {
    if (!isMonitoring || !model) return;
    const source = isRTSP ? imageRef.current : videoRef.current;
    const canvas = canvasRef.current;
    if (!source || !canvas) return;
    const ctx = canvas.getContext('2d');
    let busy = false;

    trackersRef.current   = [];
    colorCacheRef.current = {};
    colorHistRef.current  = {};
    preFetchRef.current   = {};

    function getSideOfLine(x, y, lineObj, canvasWidth, canvasHeight) {
      const ly1 = canvasHeight * lineObj.left;
      const ly2 = canvasHeight * lineObj.right;
      return (canvasWidth * (y - ly1) - (ly2 - ly1) * x) > 0;
    }

    function drawLine(lineObj, color, tag, lbl) {
      const y1 = canvas.height * lineObj.left;
      const y2 = canvas.height * lineObj.right;
      ctx.save();
      ctx.setLineDash([18, 8]); ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(canvas.width, y2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(28, y1 + (y2 - y1) * (28 / canvas.width), 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(tag, 28, y1 + (y2 - y1) * (28 / canvas.width) + 4);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(canvas.width - 28, y2 - (y2 - y1) * (28 / canvas.width), 10, 0, Math.PI * 2); ctx.fill();
      const midY = (y1 + y2) / 2;
      ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      const tw = ctx.measureText(lbl).width + 30;
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.beginPath(); ctx.roundRect(canvas.width / 2 - tw / 2, midY - 12, tw, 24, 12); ctx.fill();
      ctx.fillStyle = color; ctx.fillText(lbl, canvas.width / 2, midY + 4);
      ctx.restore();
    }

    async function tick() {
      if (busy) { if (isMonitoring) requestRef.current = requestAnimationFrame(tick); return; }
      busy = true;
      try {
        const ready = isRTSP
          ? (source.complete && source.naturalWidth > 0)
          : (source.readyState >= 2 && source.videoWidth > 0);
        if (!ready) { busy = false; if (isMonitoring) requestRef.current = requestAnimationFrame(tick); return; }

        canvas.width  = isRTSP ? source.naturalWidth  : source.videoWidth;
        canvas.height = isRTSP ? source.naturalHeight : source.videoHeight;

        const preds = await model.detect(source, 30, 0.40);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        drawLine(line1Ref.current, '#10b981', 'L1', '▼  LINE 1 — ENTERING');
        drawLine(line2Ref.current, '#f5a623', 'L2', '▲  LINE 2 — EXITING');

        const cars = preds
          .filter(p => p.class !== 'person')
          .map(p => ({
            ...p,
            rawClass: p.class,
            label: 'Car',
            area: p.bbox[2] * p.bbox[3],
            cx: p.bbox[0] + p.bbox[2] / 2,
            cy: p.bbox[1] + p.bbox[3] / 2,
          }))
          .filter(p => p.area > canvas.width * canvas.height * 0.005);

        const nextTrackers = [];
        const matchedIds   = new Set();

        for (const car of cars) {
          // ── IoU-first tracker matching ──
          let best = null, bestIoU = -1, bestDist = Infinity;
          for (const t of trackersRef.current) {
            const iou  = t.bbox ? computeIoU(car.bbox, t.bbox) : 0;
            const dist = Math.hypot(car.cx - t.cx, car.cy - t.cy);
            if (iou > bestIoU || (iou === bestIoU && dist < bestDist)) {
              bestIoU = iou; bestDist = dist; best = t;
            }
          }
          // Require meaningful IoU overlap OR tight centroid proximity — prevents stealing a nearby car's tracker
          if (bestIoU < 0.2 && bestDist >= 120) best = null;

          const t = best
            ? { ...best, prevCx: best.cx, prevCy: best.cy, cx: car.cx, cy: car.cy, bbox: car.bbox, lostFrames: 0 }
            : {
                id: `t${_tid++}`,
                cx: car.cx, cy: car.cy, prevCx: null, prevCy: null,
                bbox: car.bbox,
                l1Crossed: false, l2Crossed: false,
                firstLine: null,
                triggered: false,
                frameBuffer: [],
                capturedIntervals: new Set(),
                frames: 0,
                lostFrames: 0,
              };
          t.frames++;
          matchedIds.add(t.id);

          // ── 1. Per-tracker line crossing (no global lock) ──
          if (t.prevCy !== null && !t.triggered) {
            const curL1 = getSideOfLine(car.cx, car.cy, line1Ref.current, canvas.width, canvas.height);
            const preL1 = getSideOfLine(t.prevCx, t.prevCy, line1Ref.current, canvas.width, canvas.height);
            const curL2 = getSideOfLine(car.cx, car.cy, line2Ref.current, canvas.width, canvas.height);
            const preL2 = getSideOfLine(t.prevCx, t.prevCy, line2Ref.current, canvas.width, canvas.height);

            if (!t.l1Crossed && curL1 !== preL1) {
              t.l1Crossed = true;
              if (t.firstLine === null) t.firstLine = 1;
              if (!preFetchRef.current[t.id]) {
                try { preFetchRef.current[t.id] = fetchPlate(captureFrame(source, isRTSP)); } catch {}
              }
            }
            if (!t.l2Crossed && curL2 !== preL2) {
              t.l2Crossed = true;
              if (t.firstLine === null) t.firstLine = 2;
              if (!preFetchRef.current[t.id]) {
                try { preFetchRef.current[t.id] = fetchPlate(captureFrame(source, isRTSP)); } catch {}
              }
            }
          }

          // ── 2. Color sampling ──
          if (t.l1Crossed && frameRef.current % 2 === 0) {
            const c = sampleColor(source, car.bbox, isRTSP);
            if (!colorHistRef.current[t.id]) colorHistRef.current[t.id] = [];
            colorHistRef.current[t.id].push(c);
            if (colorHistRef.current[t.id].length > 10) colorHistRef.current[t.id].shift();
            const votes  = colorHistRef.current[t.id].reduce((a, v) => { a[v] = (a[v] || 0) + 1; return a; }, {});
            const sorted = Object.keys(votes).sort((a, b) => votes[b] - votes[a]);
            if (votes[sorted[0]] >= 6) colorCacheRef.current[t.id] = sorted[0];
          }

          // ── 2.5 Multi-frame capture ──
          if ((t.l1Crossed || t.l2Crossed) && !t.triggered) {
            const l1Y  = getLineYAtX(line1Ref.current, car.cx, canvas.width, canvas.height);
            const l2Y  = getLineYAtX(line2Ref.current, car.cx, canvas.width, canvas.height);
            const range    = Math.abs(l2Y - l1Y);
            const progress = range > 0 ? (Math.abs(car.cy - l1Y) / range) : 0;
            [0.1, 0.3, 0.5, 0.7, 0.9].forEach(interval => {
              if (!t.capturedIntervals.has(interval) && Math.abs(progress - interval) < 0.08) {
                try {
                  t.frameBuffer.push(captureFrame(source, isRTSP));
                  t.capturedIntervals.add(interval);
                } catch {}
              }
            });
          }

          // ── 3. Trigger — each car independently, no panel-open gate ──
          if (t.l1Crossed && t.l2Crossed && !t.triggered && car.score > 0.20) {
            t.triggered = true;  // set synchronously before any async work

            const direction = t.firstLine === 1 ? 'INGRESS' : 'EGRESS';
            const colorName = colorCacheRef.current[t.id] || 'Unknown';
            const newId     = `VEH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
            const imageUrl  = t.frameBuffer[Math.floor(t.frameBuffer.length / 2)]
              || t.frameBuffer[0]
              || (() => { try { return captureFrame(source, isRTSP); } catch { return ''; } })();

            const m = {
              id: newId,
              qrCodeUrl: `https://chart.googleapis.com/chart?chs=150x150&cht=qr&chl=${newId}&choe=UTF-8`,
              imageUrl, colorName,
              type: car.label,
              confidence: car.score,
              timestamp: new Date().toISOString(),
              direction,
              licensePlate: '', plateImageUrl: null, plateStatus: 'scanning',
              scanAttempt: 1, totalAttempts: t.frameBuffer.length || 1,
            };

            setDetectionQueue(prev => {
              const next = [...prev, m];
              // Auto-select exit vehicle only when this is the first (and only) item in queue
              if (direction === 'EGRESS' && next.length === 1) {
                const entered = vehiclesRef.current.filter(v => v.status === 'ENTERED');
                if (entered.length > 0) setSelectedExit(entered[0].id);
              }
              return next;
            });

            // Sequential OCR — updates queue item by ID regardless of queue position
            const validateSequential = async (index) => {
              const currentUrl = t.frameBuffer[index] || imageUrl;
              setDetectionQueue(prev => prev.map(item =>
                item.id === newId ? { ...item, scanAttempt: index + 1 } : item
              ));

              const pr = await fetchPlate(currentUrl);
              const isStrong = pr && pr.found && (pr.ocr_confidence > 0.85 || (pr.plate_text && pr.plate_text.length >= 8));

              if (isStrong || index >= t.frameBuffer.length - 1) {
                if (!pr || pr.error || !pr.found) {
                  setDetectionQueue(prev => prev.map(item =>
                    item.id === newId
                      ? { ...item, plateStatus: 'not_found', detectionLog: pr?.detection_log || [] }
                      : item
                  ));
                  return;
                }
                setDetectionQueue(prev => prev.map(item => {
                  if (item.id !== newId) return item;
                  return {
                    ...item,
                    licensePlate:  pr.plate_text  || '',
                    plateImageUrl: pr.image_b64   || null,
                    plateStatus:   'found',
                    detectionLog:  pr.detection_log || [],
                  };
                }));
                // Auto-match egress only if this item is currently at the head of the queue
                if (direction === 'EGRESS' && queueRef.current[0]?.id === newId) {
                  const entered = vehiclesRef.current.filter(v => v.status === 'ENTERED');
                  const hit = entered.find(v => v.licensePlate && pr.plate_text &&
                    v.licensePlate.toUpperCase() === pr.plate_text.toUpperCase())
                    || entered.find(v => v.colorName === colorName && v.type === car.label);
                  if (hit) setSelectedExit(hit.id);
                }
              } else {
                validateSequential(index + 1);
              }
            };

            validateSequential(0);
          }

          // ── 4. Draw bounding box once car has crossed at least one line ──
          if (t.l1Crossed || t.l2Crossed) {
            const [bx, by, bw, bh] = car.bbox;
            const boxColor = (t.l1Crossed && t.l2Crossed) ? '#a855f7' : '#00d2ff';
            ctx.strokeStyle = boxColor; ctx.lineWidth = 4;
            ctx.strokeRect(bx, by, bw, bh);

            const colorLabel = colorCacheRef.current[t.id] || '...';
            const txt = `${colorLabel} ${car.label} ${Math.round(car.score * 100)}%`;
            ctx.font = 'bold 15px sans-serif';
            const tw = ctx.measureText(txt).width + 12;
            ctx.fillStyle = boxColor; ctx.fillRect(bx, by > 22 ? by - 22 : by + bh, tw, 20);
            ctx.fillStyle = '#000'; ctx.fillText(txt, bx + 6, (by > 22 ? by - 22 : by + bh) + 14);

            const prog = (t.l1Crossed && t.l2Crossed) ? '✓ CAPTURED'
              : t.l1Crossed ? 'L1 ✓  →  L2...' : 'L2 ✓  →  L1...';
            ctx.font = 'bold 11px sans-serif';
            const pw = ctx.measureText(prog).width + 12;
            ctx.fillStyle = 'rgba(168,85,247,0.9)'; ctx.fillRect(bx, by + bh + 2, pw, 18);
            ctx.fillStyle = '#fff'; ctx.fillText(prog, bx + 6, by + bh + 14);
          }

          nextTrackers.push(t);
        }

        // Carry forward trackers for cars temporarily out of frame
        for (const oldT of trackersRef.current) {
          if (!matchedIds.has(oldT.id)) {
            oldT.lostFrames = (oldT.lostFrames || 0) + 1;
            if (oldT.lostFrames < 15) nextTrackers.push(oldT);
          }
        }

        trackersRef.current = nextTrackers;
        frameRef.current++;
      } catch (e) { console.error('Detection error:', e); }
      busy = false;
      if (isMonitoring) requestRef.current = requestAnimationFrame(tick);
    }

    tick();
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [isMonitoring, isRTSP, model]);

  // ── actions ──
  const dismissMatch = () => {
    setDetectionQueue(prev => {
      const next = prev.slice(1);
      // Prepare selectedExit for the next item in queue
      if (next[0]?.direction === 'EGRESS') {
        const entered = vehiclesRef.current.filter(v => v.status === 'ENTERED');
        setSelectedExit(entered.length > 0 ? entered[0].id : '');
      } else {
        setSelectedExit('');
      }
      return next;
    });
  };

  const handleAccept = (status = 'ENTERED') => {
    const head = queueRef.current[0];
    if (!head) return;
    addVehicle({ ...head, status });
    dismissMatch();
  };

  const handleEgressUpdate = (status) => {
    if (selectedExit) updateVehicleStatus(selectedExit, status);
    dismissMatch();
  };

  // ── render ──
  const match      = detectionQueue[0] || null;
  const queueCount = detectionQueue.length;
  const isEntering = match?.direction === 'INGRESS';

  return (
    <div className="detector-section panel">
      <div className="card-top-border" style={{ backgroundColor: 'var(--accent-color)' }} />

      {/* ── header ── */}
      <div className="camera-controls" style={{ flexWrap: 'wrap', gap: '10px' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.9rem', fontWeight: 900, letterSpacing: '0.05em', textTransform: 'uppercase', flexShrink: 0 }}>
          <PlayCircle size={18} color="var(--accent-color)" />
          Stream Analysis
        </h2>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, flexWrap: 'wrap' }}>
          <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="video/*" style={{ display: 'none' }} />
          {!isMonitoring ? (
            <>
              <button
                onClick={toggleMonitoring}
                disabled={!model}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '5px 12px', fontSize: '0.72rem', fontWeight: 700,
                  background: model ? 'rgba(0,210,255,0.12)' : 'rgba(255,255,255,0.05)',
                  color: model ? 'var(--accent-color)' : 'var(--text-secondary)',
                  border: `1px solid ${model ? 'rgba(0,210,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: '6px', cursor: model ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap',
                }}
              >
                <Upload size={12} /> {model ? 'Upload Video' : 'Loading…'}
              </button>
              <button
                onClick={startRTSP}
                disabled={!model}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '5px 12px', fontSize: '0.72rem', fontWeight: 700,
                  background: model ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.05)',
                  color: model ? '#3b82f6' : 'var(--text-secondary)',
                  border: `1px solid ${model ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: '6px', cursor: model ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap',
                }}
              >
                <PlayCircle size={12} /> {model ? 'Live RTSP' : 'Initializing…'}
              </button>
              <button
                onClick={startWebcam}
                disabled={!model}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '5px 12px', fontSize: '0.72rem', fontWeight: 700,
                  background: model ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.05)',
                  color: model ? '#10b981' : 'var(--text-secondary)',
                  border: `1px solid ${model ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: '6px', cursor: model ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap',
                }}
              >
                <RefreshCw size={12} /> {model ? 'Webcam' : 'Initializing…'}
              </button>
            </>
          ) : (
            <button
              onClick={toggleMonitoring}
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '5px 12px', fontSize: '0.72rem', fontWeight: 700,
                background: 'rgba(239,68,68,0.12)', color: '#ef4444',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: '6px', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              <X size={12} /> Stop
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          {match && (
            <span style={{
              padding: '3px 10px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 800,
              background: isEntering ? 'rgba(16,185,129,0.15)' : 'rgba(168,85,247,0.15)',
              color:      isEntering ? '#10b981' : '#a855f7',
              border:    `1px solid ${isEntering ? 'rgba(16,185,129,0.35)' : 'rgba(168,85,247,0.35)'}`,
            }}>
              {isEntering ? '▼ ENTERING' : '▲ EXITING'}
            </span>
          )}
          {queueCount > 1 && (
            <span style={{
              padding: '3px 10px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 800,
              background: 'rgba(245,166,35,0.15)', color: '#f5a623',
              border: '1px solid rgba(245,166,35,0.35)',
            }}>
              +{queueCount - 1} waiting
            </span>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem', cursor: 'pointer', color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={isLooping} onChange={e => setIsLooping(e.target.checked)} style={{ accentColor: 'var(--accent-color)' }} />
            Loop
          </label>
          {error
            ? <div className="status-pill" style={{ color: 'var(--danger-color)', background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.2)', fontSize: '0.7rem' }}><div className="dot" />{error}</div>
            : <div className="live-indicator" style={{ fontSize: '0.72rem' }}>{isMonitoring && <div className="pulse-dot" />}{isMonitoring ? 'Live' : model ? 'Ready' : 'Loading AI…'}</div>
          }
        </div>
      </div>

      {/* ── video area ── */}
      <div className="video-container" style={{ position: 'relative' }}>

        {!isMonitoring && (
          <div className="monitoring-overlay animate-fade-in">
            <div className="monitoring-content">
              <Upload size={40} className="monitoring-icon" />
              <h3 style={{ fontSize: '1rem', marginBottom: '6px' }}>Ready to Process</h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                Select a source above — upload a video, connect RTSP, or use your webcam.
              </p>
              <p style={{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                Two draggable tripwire lines detect entry &amp; exit direction automatically.
              </p>
            </div>
          </div>
        )}

        <video ref={videoRef} playsInline muted loop={isLooping}
          style={{ display: (isMonitoring && !isRTSP) ? 'block' : 'none' }} />
        <img ref={imageRef}
          src={isRTSP ? `${import.meta.env.VITE_API_URL || `http://${window.location.hostname}:8000`}/video-feed${rtspUrl ? `?url=${encodeURIComponent(rtspUrl)}` : ''}` : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}
          alt="RTSP" crossOrigin="anonymous"
          style={{ display: (isMonitoring && isRTSP) ? 'block' : 'none', width: '100%', height: 'auto', background: '#000', borderRadius: '12px' }}
        />

        <canvas ref={canvasRef} className="overlay"
          style={{ display: isMonitoring ? 'block' : 'none', pointerEvents: 'auto' }}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}    onMouseLeave={onMouseUp}
        />

        {isMonitoring && !isRTSP && !isVideoPlaying && (
          <div style={{
            position: 'absolute', top: 15, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.9)', padding: '10px 16px', borderRadius: '10px', zIndex: 20,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
            border: '1px dashed var(--accent-color)', width: 'auto', maxWidth: '280px',
          }}>
            <div style={{ color: 'white', fontWeight: 900, fontSize: '0.72rem', letterSpacing: '0.05em' }}>
              CALIBRATION MODE
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.65rem', textAlign: 'center', lineHeight: 1.3 }}>
              Drag the tripwire lines on camera to align with entry/exit points.
            </div>
            <button
              onClick={() => { if (videoRef.current) videoRef.current.play(); setIsVideoPlaying(true); }}
              style={{ padding: '5px 16px', background: 'var(--accent-color)', color: '#000', fontWeight: 800, borderRadius: '4px', border: 'none', cursor: 'pointer', marginTop: '4px', fontSize: '0.7rem' }}
            >
              Start Analysis ▶
            </button>
          </div>
        )}

        {/* ── Slide-up detection panel ── */}
        {match && (
          <div className="animate-slide-up" style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
            background: 'linear-gradient(to top, rgba(10,11,14,0.97) 70%, transparent)',
            borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px',
            padding: '0 16px 16px',
          }}>
            {/* direction + queue count + dismiss */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  padding: '5px 14px', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 900, letterSpacing: '0.05em',
                  background: isEntering ? 'rgba(16,185,129,0.2)' : 'rgba(168,85,247,0.2)',
                  color:      isEntering ? '#10b981' : '#a855f7',
                  border:    `1.5px solid ${isEntering ? '#10b981' : '#a855f7'}`,
                }}>
                  {isEntering ? '▼  ENTERING' : '▲  EXITING'}
                </span>
                {queueCount > 1 && (
                  <span style={{ fontSize: '0.7rem', color: '#f5a623', fontWeight: 700 }}>
                    {queueCount - 1} more in queue
                  </span>
                )}
              </div>
              <button onClick={dismissMatch} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}>
                <X size={18} />
              </button>
            </div>

            {/* main info row */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <img src={match.imageUrl} alt="cap"
                style={{ width: 90, height: 68, objectFit: 'cover', borderRadius: '6px', flexShrink: 0, border: '2px solid rgba(255,255,255,0.08)' }} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                    background: match.colorName.toLowerCase(),
                    border: '1.5px solid rgba(255,255,255,0.2)',
                  }} />
                  <span style={{ fontWeight: 900, fontSize: '1rem', color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {match.colorName} {match.type}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
                    {Math.round(match.confidence * 100)}%
                  </span>
                </div>

                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  ID: <strong style={{ color: 'white' }}>{match.id}</strong>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {match.plateStatus === 'scanning' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-color)', fontSize: '0.78rem', fontWeight: 700 }}>
                      <RefreshCw size={11} style={{ animation: 'spin 1.5s linear infinite' }} />
                      Scanning frame {match.scanAttempt} of {match.totalAttempts}...
                    </div>
                  ) : (
                    <>
                      {match.plateImageUrl && (
                        <img src={match.plateImageUrl} alt="plate"
                          style={{ height: 28, maxWidth: 90, objectFit: 'contain', borderRadius: '3px', background: '#000' }} />
                      )}
                      <input
                        type="text"
                        value={match.licensePlate}
                        onChange={e => {
                          const val = e.target.value.toUpperCase();
                          setDetectionQueue(prev => prev.map(item =>
                            item.id === match.id ? { ...item, licensePlate: val } : item
                          ));
                        }}
                        placeholder={match.plateStatus === 'not_found' ? 'Enter plate manually' : 'Plate...'}
                        style={{
                          flex: 1, padding: '4px 8px', background: 'rgba(255,255,255,0.07)', color: 'white',
                          border: '1px solid rgba(255,255,255,0.12)', borderRadius: '5px',
                          fontSize: '0.85rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Detection log */}
            {match.detectionLog && match.detectionLog.length > 0 && (
              <div style={{ marginTop: '10px', borderRadius: '6px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{
                  padding: '5px 10px', background: 'rgba(0,210,255,0.08)',
                  fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.08em',
                  color: 'var(--accent-color)', textTransform: 'uppercase',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                }}>
                  Detection Log
                </div>
                <div style={{
                  maxHeight: '110px', overflowY: 'auto', padding: '6px 10px',
                  background: 'rgba(0,0,0,0.45)', fontFamily: 'monospace',
                  fontSize: '0.62rem', lineHeight: 1.6, color: '#c0c8d8',
                }}>
                  {match.detectionLog.map((line, i) => {
                    const color = line.startsWith('[CAR]')    ? '#10b981'
                      : line.startsWith('[PLATE]')  ? '#3b82f6'
                      : line.startsWith('[OCR]')    ? '#f5a623'
                      : line.startsWith('[RESULT]') ? '#a855f7'
                      : line.startsWith('[ERROR]')  ? '#ef4444'
                      : '#c0c8d8';
                    return <div key={i} style={{ color, whiteSpace: 'pre' }}>{line}</div>;
                  })}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div style={{ marginTop: '12px' }}>
              {isEntering ? (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => handleAccept('ENTERED')} style={{
                    flex: 1, padding: '9px', borderRadius: '7px', border: 'none', cursor: 'pointer',
                    background: '#10b981', color: 'white', fontWeight: 800, fontSize: '0.82rem',
                  }}>Accept</button>
                  <button onClick={() => handleAccept('WAITING')} style={{
                    flex: 1, padding: '9px', borderRadius: '7px', border: 'none', cursor: 'pointer',
                    background: 'var(--accent-color)', color: 'black', fontWeight: 800, fontSize: '0.82rem',
                  }}>Wait</button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <select value={selectedExit} onChange={e => setSelectedExit(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.07)', color: 'white', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', fontSize: '0.82rem' }}>
                    <option value="" disabled>Select vehicle in workshop...</option>
                    {vehicles.filter(v => v.status === 'ENTERED').map(v => (
                      <option key={v.id} value={v.id}>{v.id} — {v.colorName} {v.type}{v.licensePlate ? ` [${v.licensePlate}]` : ''}</option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => handleEgressUpdate('TEMP_OUT')} style={{ flex: 1, padding: '9px', borderRadius: '7px', border: '1px solid #f472b6', background: 'transparent', color: '#f472b6', fontWeight: 800, cursor: 'pointer', fontSize: '0.82rem' }}>Temp Out</button>
                    <button onClick={() => handleEgressUpdate('EXITED')}   style={{ flex: 1, padding: '9px', borderRadius: '7px', border: '1px solid #a855f7', background: 'transparent', color: '#a855f7', fontWeight: 800, cursor: 'pointer', fontSize: '0.82rem' }}>Exited</button>
                    <button onClick={dismissMatch} style={{ padding: '9px 12px', borderRadius: '7px', border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.82rem' }}>✕</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 58mm thermal print */}
      {match && (
        <div className="thermal-print-container">
          <div className="thermal-ticket">
            <h2>AUTOTRACK GATE</h2><hr />
            <div style={{ fontSize: '11px', fontWeight: 'bold', margin: '4px 0' }}>{isEntering ? '▼ ENTRY' : '▲ EXIT'}</div>
            <div style={{ fontSize: '22px', fontWeight: 'bold', margin: '8px 0' }}>{match.id}</div>
            <p>{match.colorName} {match.type}</p>
            {match.licensePlate && <p style={{ fontSize: '16px', fontWeight: 'bold', letterSpacing: '0.15em', margin: '5px 0' }}>{match.licensePlate}</p>}
            <p>{isEntering ? 'Entry' : 'Exit'}: {new Date(match.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
            <div style={{ margin: '12px 0' }}><img src={match.qrCodeUrl} alt="QR" style={{ width: '110px' }} /></div>
            <p style={{ fontSize: '10px' }}>Place on Dashboard</p>
          </div>
        </div>
      )}
    </div>
  );
}
