import { useState } from 'react';
import { PlayCircle, RefreshCw, Upload, Wifi, X } from 'lucide-react';
import { useShop } from '../context/ShopContext';

const OPTIONS = [
  { id: 'rtsp',   label: 'RTSP Camera',  desc: 'IP/network camera via RTSP stream', icon: Wifi,       color: '#3b82f6' },
  { id: 'webcam', label: 'USB / Webcam', desc: 'Local camera or USB device',         icon: RefreshCw,  color: '#10b981' },
  { id: 'upload', label: 'Upload Video', desc: 'Test or replay with a video file',   icon: Upload,     color: '#00d2ff' },
];

export default function FeedConfigModal({ isOpen, onClose }) {
  const { feedSource, rtspUrl, setFeedConfig } = useShop();
  const isFirstLaunch = !feedSource;

  const [selected, setSelected] = useState(feedSource || 'webcam');
  const [rtspInput, setRtspInput] = useState(rtspUrl || '');

  if (!isOpen) return null;

  const canSave = selected !== 'rtsp' || rtspInput.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    setFeedConfig(selected, selected === 'rtsp' ? rtspInput.trim() : '');
    onClose?.();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: 'rgba(0,0,0,0.88)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(6px)',
    }}>
      <div className="panel" style={{ width: '100%', maxWidth: '480px', padding: '2rem', position: 'relative' }}>

        {!isFirstLaunch && onClose && (
          <button
            onClick={onClose}
            style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4 }}
          >
            <X size={18} />
          </button>
        )}

        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <PlayCircle size={18} color="var(--accent-color)" />
            <h2 style={{ fontSize: '1rem', fontWeight: 900, margin: 0, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {isFirstLaunch ? 'Choose Feed Source' : 'Feed Settings'}
            </h2>
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>
            {isFirstLaunch
              ? 'Select how this device receives video. You can change this later in Settings.'
              : 'Change the video input source for this device.'}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: '1.25rem' }}>
          {OPTIONS.map(opt => {
            const active = selected === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => setSelected(opt.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '13px 16px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                  background: active ? `${opt.color}18` : 'rgba(255,255,255,0.03)',
                  border: `1.5px solid ${active ? opt.color : 'rgba(255,255,255,0.08)'}`,
                  color: 'white', transition: 'all 0.15s', width: '100%',
                }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: `${opt.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <opt.icon size={17} color={opt.color} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>{opt.label}</div>
                  <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', marginTop: 2 }}>{opt.desc}</div>
                </div>
                <div style={{
                  width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                  background: active ? opt.color : 'rgba(255,255,255,0.1)',
                  transition: 'background 0.15s',
                }} />
              </button>
            );
          })}
        </div>

        {selected === 'rtsp' && (
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              RTSP Stream URL
            </label>
            <input
              type="text"
              value={rtspInput}
              onChange={e => setRtspInput(e.target.value)}
              placeholder="rtsp://user:pass@192.168.1.100:554/stream"
              autoFocus
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: '0.8rem',
                background: 'rgba(255,255,255,0.05)', color: 'white',
                border: `1px solid ${rtspInput.trim() ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.12)'}`,
                outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box',
                transition: 'border-color 0.15s',
              }}
            />
            {rtspInput.trim() && !rtspInput.trim().startsWith('rtsp://') && (
              <div style={{ fontSize: '0.7rem', color: '#f5a623', marginTop: 5 }}>
                URL should start with rtsp://
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{
              flex: 1, padding: '11px', borderRadius: 8, border: 'none', cursor: canSave ? 'pointer' : 'not-allowed',
              background: 'var(--accent-color)', color: '#000', fontWeight: 800, fontSize: '0.88rem',
              opacity: canSave ? 1 : 0.4, transition: 'opacity 0.15s',
            }}
          >
            {isFirstLaunch ? 'Start Monitoring' : 'Save Changes'}
          </button>
          {!isFirstLaunch && onClose && (
            <button
              onClick={onClose}
              style={{
                padding: '11px 20px', borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.1)', background: 'transparent',
                color: 'var(--text-secondary)', cursor: 'pointer', fontWeight: 600, fontSize: '0.88rem',
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
