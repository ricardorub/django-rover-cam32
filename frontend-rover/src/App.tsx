import { useState, useEffect, useRef, useCallback } from 'react';

// Backend address config
const BACKEND = 'http://' + (window.location.hostname || 'localhost') + ':8001';

interface LogEntry {
  time: string;
  message: string;
}

const speedMapping: Record<string, string> = {
  '0.0': '60 (Min)',
  '0.1': '70',
  '0.2': '81',
  '0.3': '95',
  '0.4': '105',
  '0.5': '122',
  '0.6': '150',
  '0.7': '196',
  '0.8': '272',
  '0.9': '400',
  '1.0': '1023 (Max)'
};

export default function App() {
  // Modes & System States
  const [currentMode, setCurrentMode] = useState<'MANUAL' | 'AI' | 'AI2' | 'AUTO'>('MANUAL');
  const [isRecording, setIsRecording] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [bandwidth, setBandwidth] = useState<number | null>(null);
  const [speed, setSpeed] = useState('0.5');
  const [logs, setLogs] = useState<LogEntry[]>([{ time: '--:--:--', message: 'SYS: Waiting for logs...' }]);

  // Modals state
  const [confirmModal, setConfirmModal] = useState<{ show: boolean; msg: string; onConfirm?: () => void }>({ show: false, msg: '' });
  const [joyModalOpen, setJoyModalOpen] = useState(false);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const [gamepadId, setGamepadId] = useState('');
  const [activeMappingInput, setActiveMappingInput] = useState<string | null>(null);
  const [gamepadMappings, setGamepadMappings] = useState<Record<string, string>>({
    'F': '',
    'B': '',
    'L': '',
    'R': '',
    'S': ''
  });

  // Camera State Headers
  const [newMissionOverlay, setNewMissionOverlay] = useState(false);
  const [newMissionText, setNewMissionText] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  // Voice Mode Active State
  const [voiceModeActive, setVoiceModeActive] = useState(false);
  const [micPressed, setMicPressed] = useState(false);
  const [voiceStatusText, setVoiceStatusText] = useState('MANTÉN PRESIONADO');
  const [loadingOverlay, setLoadingOverlay] = useState<{ show: boolean; text: string }>({ show: false, text: '' });

  // Direction State for UI highlighting
  const [currentDirection, setCurrentDirection] = useState<'F' | 'B' | 'L' | 'R' | 'S'>('S');

  // Refs for audio capturing
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioBuffersRef = useRef<Float32Array[]>([]);

  // Refs for image frame loaders and connections
  const videoFeedRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Animation values for Voice Wave Canvas
  const targetAmplitude = useRef(6);
  const currentAmplitude = useRef(6);
  const targetFrequency = useRef(0.025);
  const currentFrequency = useRef(0.025);
  const targetSpeed = useRef(0.03);
  const currentSpeed = useRef(0.03);
  const wavePhase = useRef(0);

  // Helper log function
  const logFrontend = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => {
      const updated = [...prev, { time: timestamp, message: `FE: ${message}` }];
      return updated.slice(-50); // Keep last 50
    });
    console.log("FE Log:", message);
  }, []);

  // Modal Custom Confirmation Promise Helper
  const customConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmModal({
        show: true,
        msg: message,
        onConfirm: () => {
          setConfirmModal({ show: false, msg: '' });
          resolve(true);
        }
      });
    });
  }, []);

  // WebSocket for Direct Commands (Manual Mode only)
  const connectToESP = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    
    logFrontend("Connecting to ESP8266 WebSocket control...");
    const ws = new WebSocket('ws://192.168.1.99:81');
    wsRef.current = ws;

    ws.onopen = () => {
      logFrontend("ESP8266 WS connection established successfully.");
    };

    ws.onerror = () => {
      logFrontend("ESP8266 WS Connection error.");
    };

    ws.onclose = () => {
      logFrontend("ESP8266 WS disconnected. Reconnecting in 3s...");
      setTimeout(connectToESP, 3000);
    };
  }, [logFrontend]);

  useEffect(() => {
    connectToESP();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectToESP]);

  // Send Command to ESP via WebSocket
  const sendCommand = useCallback((cmd: string) => {
    logFrontend(`sendCommand called with state: ${cmd}`);
    if (currentMode !== 'MANUAL') {
      logFrontend(`Command ignored: Mode is ${currentMode}, not MANUAL`);
      return;
    }
    
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        logFrontend(`Sending directly to ESP8266 via WS: ${cmd}`);
        wsRef.current.send(cmd);
      } catch (e: any) {
        logFrontend(`Failed to send via WS: ${e.message}`);
      }
    } else {
      logFrontend(`ESP8266 WS disconnected. Cannot send command: ${cmd}`);
    }
  }, [currentMode, logFrontend]);

  // Direction Handler
  const setDirection = useCallback((cmd: 'F' | 'B' | 'L' | 'R' | 'S') => {
    if (currentMode !== 'MANUAL') {
      logFrontend(`Command ignored: Mode is ${currentMode}, not MANUAL`);
      return;
    }
    setCurrentDirection(cmd);
    logFrontend(`Setting direction: ${cmd}`);
    sendCommand(cmd);
  }, [currentMode, sendCommand, logFrontend]);

  // Telemetry Fetcher
  useEffect(() => {
    if (!isRecording) return;
    const fetchTelemetry = async () => {
      try {
        const res = await fetch(`${BACKEND}/telemetry/`);
        const data = await res.json();
        setLatency(data.latency);
        setBandwidth(data.bandwidth);
      } catch (e) {
        console.error('Failed to fetch telemetry:', e);
      }
    };

    const interval = setInterval(fetchTelemetry, 1000);
    fetchTelemetry();
    return () => clearInterval(interval);
  }, [isRecording]);

  // Django Logs Sync
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(`${BACKEND}/logs/`);
        const data = await res.json();
        if (data.logs) {
          setLogs(prev => {
            const frontendLogs = prev.filter(l => l.message.startsWith('FE:'));
            const combined = [...frontendLogs, ...data.logs].sort((a, b) => a.time.localeCompare(b.time));
            return combined.slice(-50);
          });
        }
      } catch (e) {
        console.error('Failed to fetch logs:', e);
      }
    };
    const interval = setInterval(fetchLogs, 2000);
    fetchLogs();
    return () => clearInterval(interval);
  }, []);

  // Frame Loading Loop
  useEffect(() => {
    let active = true;
    let timeoutId: number;

    const loadNextFrame = async () => {
      if (!active) return;
      try {
        const aiParam = currentMode === 'AI' ? 'true' : 'false';
        const ai2Param = currentMode === 'AI2' ? 'true' : 'false';
        const autoParam = currentMode === 'AUTO' ? 'true' : 'false';
        
        let url = `${BACKEND}/single_frame/?ai=${aiParam}&ai2=${ai2Param}&auto=${autoParam}&t=${Date.now()}`;
        if (isResetting) {
          url += '&reset=true';
          setIsResetting(false);
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error('Response not OK');

        // Read X-AI headers
        const aiState = response.headers.get('X-AI-State');
        const aiTarget = response.headers.get('X-AI-Target');

        if (currentMode === 'AI2' && aiState === 'COMPLETED') {
          setNewMissionText(`El robot entró con éxito en la casita: "${aiTarget || 'Desconocida'}"`);
          setNewMissionOverlay(true);
        } else {
          setNewMissionOverlay(false);
        }

        const blob = await response.blob();
        const objectURL = URL.createObjectURL(blob);

        if (videoFeedRef.current) {
          const oldUrl = videoFeedRef.current.dataset.srcUrl;
          if (oldUrl) {
            URL.revokeObjectURL(oldUrl);
          }
          videoFeedRef.current.dataset.srcUrl = objectURL;
          videoFeedRef.current.src = objectURL;
        }

        timeoutId = window.setTimeout(loadNextFrame, 50);
      } catch (e) {
        console.error('Frame error:', e);
        timeoutId = window.setTimeout(loadNextFrame, 1000);
      }
    };

    loadNextFrame();

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [currentMode, isResetting]);

  // Voice Mode Navigation Actions
  const activateVoiceMode = () => {
    if (voiceModeActive) return;
    setVoiceModeActive(true);
    setLoadingOverlay({ show: true, text: 'INICIALIZANDO RECONOCIMIENTO...' });
    
    setTimeout(() => {
      setLoadingOverlay({ show: false, text: '' });
      logFrontend("Modo Speech Recognition activado. Listo para comandos.");
    }, 2000);
  };

  const deactivateVoiceMode = () => {
    if (!voiceModeActive) return;
    setVoiceModeActive(false);
    setLoadingOverlay({ show: true, text: 'RECONFIGURANDO MANUAL OVERRIDE...' });

    setTimeout(() => {
      setLoadingOverlay({ show: false, text: '' });
      logFrontend("Modo Speech Recognition desactivado.");
    }, 2000);
  };

  // Web Audio PCM voice recording helpers
  const startAudioRecording = () => {
    audioBuffersRef.current = [];
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      mediaStreamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioCtx({ sampleRate: 16000 });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);
      
      processorRef.current.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        audioBuffersRef.current.push(new Float32Array(input));
      };
      logFrontend("Grabación local de voz iniciada...");
    }).catch(err => {
      logFrontend("Error acceso micrófono: " + err.message);
      setVoiceStatusText("SIN MICRÓFONO");
    });
  };

  const stopAudioRecordingAndSend = async () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    const buffers = audioBuffersRef.current;
    if (buffers.length === 0) {
      logFrontend("No se capturó audio.");
      return;
    }

    // Flatten Float32 values
    const totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.length;
    }

    // Normalize signal
    let maxVal = 0;
    for (let i = 0; i < result.length; i++) {
      const val = Math.abs(result[i]);
      if (val > maxVal) maxVal = val;
    }
    if (maxVal > 0.01) {
      const multiplier = 0.85 / maxVal;
      for (let i = 0; i < result.length; i++) {
        result[i] *= multiplier;
      }
    }

    // Float32 -> Int16 PCM (Vosk offline standard)
    const pcmData = new Int16Array(result.length);
    for (let i = 0; i < result.length; i++) {
      const s = Math.max(-1, Math.min(1, result[i]));
      pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    targetAmplitude.current = 18;
    targetSpeed.current = 0.08;
    targetFrequency.current = 0.03;
    setVoiceStatusText("PROCESANDO CON VOSK (OFFLINE)...");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      const response = await fetch(`${BACKEND}/voice_control/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcmData.buffer,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await response.json();

      if (data.status === 'success') {
        logFrontend(`Vosk Offline: "${data.text_heard}" -> Acción [${data.command_executed}]`);
        targetAmplitude.current = 45;
        targetSpeed.current = 0.22;
        targetFrequency.current = 0.055;
        setVoiceStatusText(`EJECUTADO: ${data.command_executed}`);
        
        setTimeout(() => {
          if (!micPressed) {
            targetAmplitude.current = 6;
            targetSpeed.current = 0.03;
            targetFrequency.current = 0.025;
            setVoiceStatusText("MANTÉN PRESIONADO");
          }
        }, 800);
      } else {
        logFrontend("Vosk Offline retornó error: " + data.message);
        setVoiceStatusText("ERROR AL INTERPRETAR");
        setTimeout(() => {
          setVoiceStatusText("MANTÉN PRESIONADO");
        }, 2000);
      }
    } catch (e: any) {
      clearTimeout(timeoutId);
      logFrontend("Fallo al contactar al servidor: " + e.message);
      setVoiceStatusText("CONEXION FALLIDA");
      setTimeout(() => {
        setVoiceStatusText("MANTÉN PRESIONADO");
      }, 2000);
    }
  };

  const startVoiceInput = () => {
    setMicPressed(true);
    targetAmplitude.current = 32;
    targetSpeed.current = 0.14;
    targetFrequency.current = 0.045;
    setVoiceStatusText("HABLA AHORA...");
    startAudioRecording();
  };

  const stopVoiceInput = () => {
    setMicPressed(false);
    targetAmplitude.current = 6;
    targetSpeed.current = 0.03;
    targetFrequency.current = 0.025;
    setVoiceStatusText("PROCESANDO...");
    
    setTimeout(() => {
      stopAudioRecordingAndSend();
    }, 350);
  };

  // Keyboard Event Handlers (Manual control)
  useEffect(() => {
    if (currentMode !== 'MANUAL' || voiceModeActive) return;

    const keyMap: Record<string, 'F' | 'B' | 'L' | 'R' | 'S'> = {
      'ArrowUp': 'B',
      'KeyW': 'B',
      'ArrowDown': 'F',
      'KeyS': 'F',
      'ArrowLeft': 'R',
      'KeyA': 'R',
      'ArrowRight': 'L',
      'KeyD': 'L',
      'Space': 'S'
    };

    const activeKeys = new Set<string>();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', ' '].includes(e.key) || ['KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code)) {
        e.preventDefault();
      }

      let cmdKey = e.code;
      if (e.key === ' ') cmdKey = 'Space';
      else if (e.key.startsWith('Arrow')) cmdKey = e.key;

      if (keyMap[cmdKey] && !activeKeys.has(cmdKey)) {
        activeKeys.add(cmdKey);
        logFrontend(`Keyboard down: ${cmdKey} -> ${keyMap[cmdKey]}`);
        setDirection(keyMap[cmdKey]);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      let cmdKey = e.code;
      if (e.key === ' ') cmdKey = 'Space';
      else if (e.key.startsWith('Arrow')) cmdKey = e.key;

      if (activeKeys.has(cmdKey)) {
        activeKeys.delete(cmdKey);
        logFrontend(`Keyboard up: ${cmdKey}`);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [currentMode, voiceModeActive, setDirection, logFrontend]);

  // Voice Wave Sinusoidal animation loop
  useEffect(() => {
    let animationFrameId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const drawVoiceWave = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
      }

      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      currentAmplitude.current += (targetAmplitude.current - currentAmplitude.current) * 0.1;
      currentFrequency.current += (targetFrequency.current - currentFrequency.current) * 0.1;
      currentSpeed.current += (targetSpeed.current - currentSpeed.current) * 0.1;
      wavePhase.current += currentSpeed.current;

      const waveLayers = 3;
      const colors = [
        'rgba(0, 240, 255, 0.5)',
        'rgba(0, 240, 255, 0.25)',
        'rgba(0, 240, 255, 0.1)'
      ];

      for (let l = 0; l < waveLayers; l++) {
        ctx.beginPath();
        ctx.lineWidth = l === 0 ? 2 : 1;
        ctx.strokeStyle = colors[l];

        const phaseOffset = (l * Math.PI) / 3;
        const ampMultiplier = 1.0 - l * 0.3;

        for (let x = 0; x < w; x++) {
          const y = h / 2 + Math.sin(x * currentFrequency.current + wavePhase.current + phaseOffset) * (currentAmplitude.current * ampMultiplier);
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      animationFrameId = requestAnimationFrame(drawVoiceWave);
    };

    drawVoiceWave();
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  // Gamepad Loop
  useEffect(() => {
    let animationId: number;
    let lastActiveInput = '';

    const checkGamepadControls = (gp: Gamepad) => {
      if (currentMode !== 'MANUAL' || joyModalOpen) return;

      let detectedInput = '';
      gp.buttons.forEach((button, index) => {
        if (button.pressed) detectedInput = `Button ${index}`;
      });

      if (!detectedInput) {
        gp.axes.forEach((axis, index) => {
          if (Math.abs(axis) > 0.5) {
            detectedInput = `Axis ${index} (${axis > 0 ? '+' : '-'})`;
          }
        });
      }

      if (detectedInput && detectedInput !== lastActiveInput) {
        lastActiveInput = detectedInput;
        logFrontend(`Gamepad active input: ${detectedInput}`);
        
        for (const [direction, mappedInput] of Object.entries(gamepadMappings)) {
          if (mappedInput && mappedInput === detectedInput) {
            setDirection(direction as any);
            break;
          }
        }
      } else if (!detectedInput && lastActiveInput) {
        lastActiveInput = '';
      }
    };

    const updateGamepad = () => {
      const gamepads = navigator.getGamepads();
      if (gamepads[0]) {
        const gp = gamepads[0];
        setGamepadConnected(true);
        setGamepadId(gp.id.substring(0, 20) + '...');
        
        if (activeMappingInput) {
          gp.buttons.forEach((button, index) => {
            if (button.pressed) {
              setGamepadMappings(prev => ({ ...prev, [activeMappingInput]: `Button ${index}` }));
              setActiveMappingInput(null);
            }
          });

          gp.axes.forEach((axis, index) => {
            if (Math.abs(axis) > 0.5) {
              setGamepadMappings(prev => ({ ...prev, [activeMappingInput]: `Axis ${index} (${axis > 0 ? '+' : '-'})` }));
              setActiveMappingInput(null);
            }
          });
        } else {
          checkGamepadControls(gp);
        }
      } else {
        setGamepadConnected(false);
        setGamepadId('');
      }
      animationId = requestAnimationFrame(updateGamepad);
    };

    updateGamepad();

    // Load saved config
    const saved = localStorage.getItem('gamepadMappings');
    if (saved) {
      setGamepadMappings(JSON.parse(saved));
    }

    return () => cancelAnimationFrame(animationId);
  }, [currentMode, joyModalOpen, activeMappingInput, gamepadMappings, setDirection, logFrontend]);

  // Mode Selection handler with Custom Confirmation
  const handleModeChange = async (mode: 'MANUAL' | 'AI' | 'AI2' | 'AUTO') => {
    let msg = `Are you sure you want to switch to ${mode} mode?`;
    if (mode === 'AI') msg = "Are you sure you want to activate AI detection?";
    if (mode === 'AI2') msg = "Are you sure you want to activate AI - 2 (QR Navigation) mode?";
    if (mode === 'AUTO') msg = "Are you sure you want to activate AUTO (Blue Cap Tracking) mode?";

    if (await customConfirm(msg)) {
      deactivateVoiceMode();
      setCurrentMode(mode);
    }
  };

  const handleRecordToggle = async () => {
    const action = isRecording ? "stop" : "start";
    if (await customConfirm(`Are you sure you want to ${action} recording?`)) {
      setIsRecording(!isRecording);
      logFrontend(`Recording is now ${!isRecording ? 'Active' : 'Disabled'}`);
    }
  };

  const saveGamepadConfig = () => {
    localStorage.setItem('gamepadMappings', JSON.stringify(gamepadMappings));
    logFrontend('Gamepad configuration saved: ' + JSON.stringify(gamepadMappings));
    setJoyModalOpen(false);
  };

  return (
    <div className="flex flex-1 h-screen overflow-hidden bg-[#0c0e12] text-[#e1e2e7]">
      {/* TopAppBar */}
      <header className="absolute top-0 left-0 right-0 bg-[#1d2023] border-b border-[#3b494b] flex justify-between items-center px-6 h-16 z-50">
        <div className="flex items-center gap-6">
          <h1 className="font-headline-lg text-[22px] tracking-wider text-[#00f0ff] glow-cyan uppercase">
             ZIZTEM-AI
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            <button className="p-2 rounded-full hover:bg-[#323539] text-[#00f0ff] transition-colors relative cursor-pointer">
              <span className="material-symbols-outlined glow-icon">notifications_active</span>
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[#00f0ff] rounded-full glow-status"></span>
            </button>
            <button className="p-2 rounded-full hover:bg-[#323539] text-[#00f0ff] transition-colors cursor-pointer">
              <span className="material-symbols-outlined glow-icon">power_settings_new</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 pt-16 overflow-hidden">
        {/* SideNavBar */}
        <nav className="hidden lg:flex flex-col h-full py-8 px-4 bg-[#191c1f] border-r border-[#3b494b] w-64 shrink-0 z-40">
          <div className="mb-8 px-2 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#323539] border border-[#00f0ff]/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-[#00f0ff] glow-icon">rocket</span>
            </div>
            <div>
              <h2 className="font-headline-md text-[18px] text-[#00f0ff] glow-cyan">RichiBot-v1</h2>
              <p className="font-telemetry text-[10px] text-[#b9cacb] uppercase">Exploration Rover</p>
            </div>
          </div>

          <div className="flex-1 space-y-2">
            <button
              onClick={() => deactivateVoiceMode()}
              className={`w-full flex items-center gap-3 p-3 rounded font-label-caps text-xs tracking-wider transition-all duration-200 cursor-pointer ${
                !voiceModeActive
                  ? 'bg-[#323539] text-[#00f0ff] border-l-2 border-[#00f0ff] tech-active'
                  : 'text-[#b9cacb] hover:text-[#00f0ff] hover:bg-[#323539]'
              }`}
            >
              <span className="material-symbols-outlined">dashboard</span>
              DASHBOARD
            </button>
            <button
              onClick={() => activateVoiceMode()}
              className={`w-full flex items-center gap-3 p-3 rounded font-label-caps text-xs tracking-wider transition-all duration-200 cursor-pointer ${
                voiceModeActive
                  ? 'bg-[#323539] text-[#00f0ff] border-l-2 border-[#00f0ff] tech-active'
                  : 'text-[#b9cacb] hover:text-[#00f0ff] hover:bg-[#323539]'
              }`}
            >
              <span className="material-symbols-outlined">mic</span>
              VOICE CONTROL
            </button>
            <button
              onClick={() => {
                deactivateVoiceMode();
                setJoyModalOpen(true);
              }}
              className="w-full flex items-center gap-3 p-3 rounded font-label-caps text-xs tracking-wider transition-all duration-200 cursor-pointer text-[#b9cacb] hover:text-[#00f0ff] hover:bg-[#323539]"
            >
              <span className="material-symbols-outlined">settings_input_component</span>
              CONTROLLER
            </button>
          </div>

          <div className="mt-auto space-y-2 pt-4 border-t border-[#3b494b]/40">
            <button
              onClick={async () => {
                if (await customConfirm("Are you sure you want to trigger EMERGENCY STOP? All systems will halt.")) {
                  if (isRecording) setIsRecording(false);
                  setDirection('S');
                }
              }}
              className="w-full mt-4 bg-[#ffb4ab] text-[#690005] font-label-caps text-xs py-3 rounded border border-[#93000a] hover:brightness-110 transition-all shadow-[0_0_15px_rgba(255,180,171,0.3)] cursor-pointer"
            >
              EMERGENCY STOP
            </button>
          </div>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 p-6 overflow-y-auto flex flex-col gap-6">
          {/* Main Workspace: Cam & Control panel */}
          <div className="flex flex-col xl:flex-row gap-6 h-full">
            {/* Central Video Feed */}
            <div className="flex-1 tech-panel rounded-lg flex flex-col relative overflow-hidden min-h-[400px]">
              <div className="bg-[#282a2e]/80 backdrop-blur-md px-4 py-2 border-b border-[#00f0ff]/20 flex justify-between items-center z-10 relative">
                <span className="font-label-caps text-xs text-[#00f0ff] glow-cyan">CAM-01: LIVE FEED</span>
                <div className="flex gap-6 font-telemetry text-[11px] text-[#b9cacb]">
                  <span className="flex items-center gap-2 text-[#00f0ff] glow-cyan">
                    <span className="w-2 h-2 rounded-full bg-[#00f0ff] glow-status"></span> ONLINE
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full transition-colors ${isRecording ? 'bg-red-500 glow-status' : 'bg-[#323539]'}`}></span> REC
                  </span>
                  <span>LATENCY: {latency !== null ? `${latency}ms` : '--ms'}</span>
                  <span>BANDWIDTH: {bandwidth !== null ? `${bandwidth.toFixed(2)} Mbps` : '-- Mbps'}</span>
                </div>
              </div>

              <div className="flex-1 relative bg-[#0c0e12] overflow-hidden">
                {/* Image Live feed */}
                <img
                  ref={videoFeedRef}
                  src={`${BACKEND}/video_feed/?ai=false`}
                  className="absolute inset-0 w-full h-full object-cover opacity-70 grayscale-[0.2]"
                  alt="Rover Optics"
                />
                <div className="absolute inset-0 scanline opacity-30 pointer-events-none"></div>

                {/* New Mission Overlay Panel */}
                <div
                  className={`absolute inset-0 bg-black/75 backdrop-blur-md flex flex-col justify-center items-center gap-4 z-20 transition-all duration-300 ${
                    newMissionOverlay ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  <div className="text-white font-label-caps text-lg tracking-wider glow-cyan animate-pulse">
                    ¡MISIÓN COMPLETADA!
                  </div>
                  <div className="text-[#b9cacb] font-body-md text-xs">{newMissionText}</div>
                  <button
                    onClick={() => {
                      setIsResetting(true);
                      setNewMissionOverlay(false);
                    }}
                    className="bg-[#00f0ff] text-[#00363a] hover:bg-[#dbfcff] transition-all px-6 py-2.5 rounded-lg border border-[#00f0ff]/40 font-label-caps text-xs shadow-lg uppercase tracking-widest glow-cyan cursor-pointer"
                  >
                    Nueva Misión
                  </button>
                </div>

                {/* Crosshairs & Diagnostics Hud */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-40 border border-[#00f0ff]/20 rounded-full flex items-center justify-center">
                    <div className="w-[1px] h-full bg-[#00f0ff]/30"></div>
                    <div className="h-[1px] w-full bg-[#00f0ff]/30 absolute"></div>
                    <div className="w-1.5 h-1.5 bg-[#00f0ff] glow-status rounded-full absolute"></div>
                    <div className="absolute top-0 left-0 w-4 h-4 border-t border-l border-[#00f0ff]"></div>
                    <div className="absolute top-0 right-0 w-4 h-4 border-t border-r border-[#00f0ff]"></div>
                    <div className="absolute bottom-0 left-0 w-4 h-4 border-b border-l border-[#00f0ff]"></div>
                    <div className="absolute bottom-0 right-0 w-4 h-4 border-b border-r border-[#00f0ff]"></div>
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(0,240,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.03)_1px,transparent_1px)] bg-[size:60px_60px]"></div>
                  <div className="absolute bottom-6 left-6 font-telemetry text-xs text-[#00f0ff] bg-[#0c0e12]/80 p-3 rounded-lg border border-[#00f0ff]/30 backdrop-blur-md shadow-lg">
                    <span className="block opacity-50 text-[9px] mb-1">COORDINATES</span>
                    X: 45.2341<br />
                    Y: -12.9822<br />
                    Z: 0.0014
                  </div>
                  <div className="absolute bottom-6 right-6 font-telemetry text-xs text-[#00f0ff] bg-[#0c0e12]/80 p-3 rounded-lg border border-[#00f0ff]/30 backdrop-blur-md text-right shadow-lg">
                    <span className="block opacity-50 text-[9px] mb-1">ORIENTATION</span>
                    PITCH: +2.4°<br />
                    ROLL: -0.1°<br />
                    YAW: 145.2°
                  </div>
                </div>
              </div>
            </div>

            {/* Right Control Panels */}
            <div className="w-full xl:w-80 flex flex-col gap-6 shrink-0">
              {/* Locomotion Override card */}
              <div className="tech-panel rounded-lg flex flex-col overflow-hidden">
                <div className="bg-[#282a2e] px-4 py-2 border-b border-[#00f0ff]/20">
                  <span className="font-label-caps text-xs text-[#00f0ff]">
                    {voiceModeActive ? 'SPEECH RECOGNITION' : 'MANUAL OVERRIDE'}
                  </span>
                </div>

                {loadingOverlay.show ? (
                  <div className="p-6 flex flex-col items-center justify-center gap-3 h-52">
                    <span className="material-symbols-outlined text-[54px] text-[#00f0ff] animate-spin glow-icon">settings</span>
                    <span className="font-telemetry text-[9px] text-[#00f0ff] glow-cyan uppercase tracking-wider">{loadingOverlay.text}</span>
                  </div>
                ) : voiceModeActive ? (
                  <div className="p-6 flex flex-col items-center justify-center gap-2 h-52 relative">
                    <canvas ref={canvasRef} width="280" height="90" className="w-full h-24 pointer-events-none mb-1"></canvas>
                    <div className="flex flex-col items-center justify-center gap-1">
                      <button
                        onMouseDown={startVoiceInput}
                        onMouseUp={stopVoiceInput}
                        onMouseLeave={stopVoiceInput}
                        onTouchStart={startVoiceInput}
                        onTouchEnd={stopVoiceInput}
                        className={`w-16 h-16 rounded-full bg-[#323539] border border-[#00f0ff]/30 hover:border-[#00f0ff] flex items-center justify-center text-[#00f0ff] hover:text-white hover:bg-[#00f0ff]/40 active:scale-95 transition-all shadow-[0_0_15px_rgba(0,240,255,0.1)] select-none cursor-pointer ${
                          micPressed ? 'bg-[#00f0ff]/20 border-[#00f0ff] scale-95' : ''
                        }`}
                      >
                        <span className={`material-symbols-outlined text-[36px] ${micPressed ? 'animate-pulse text-white' : ''}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                          mic
                        </span>
                      </button>
                      <span className="font-telemetry text-[#b9cacb] uppercase tracking-wider text-[9px] mt-1 select-none">
                        {voiceStatusText}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="p-6 flex flex-col items-center justify-center gap-2 h-52">
                    <button
                      onClick={() => setDirection('B')}
                      className={`w-14 h-14 bg-[#323539] text-[#00f0ff] rounded-lg hover:text-white hover:bg-[#00f0ff]/40 transition-all flex items-center justify-center border border-[#00f0ff]/30 shadow-inner cursor-pointer ${
                        currentDirection === 'B' ? 'bg-[#00f0ff]/40 text-white' : ''
                      }`}
                    >
                      <span className="material-symbols-outlined text-[32px]">keyboard_arrow_up</span>
                    </button>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setDirection('R')}
                        className={`w-14 h-14 bg-[#323539] text-[#00f0ff] rounded-lg hover:text-white hover:bg-[#00f0ff]/40 transition-all flex items-center justify-center border border-[#00f0ff]/30 shadow-inner cursor-pointer ${
                          currentDirection === 'R' ? 'bg-[#00f0ff]/40 text-white' : ''
                        }`}
                      >
                        <span className="material-symbols-outlined text-[32px]">keyboard_arrow_left</span>
                      </button>
                      <button
                        onClick={() => setDirection('S')}
                        className={`w-14 h-14 bg-[#191c1f] text-[#b9cacb] rounded-lg flex items-center justify-center border border-[#3b494b]/30 cursor-pointer ${
                          currentDirection === 'S' ? 'bg-[#00f0ff]/40 text-white' : ''
                        }`}
                      >
                        <span className="material-symbols-outlined text-[24px]">stop_circle</span>
                      </button>
                      <button
                        onClick={() => setDirection('L')}
                        className={`w-14 h-14 bg-[#323539] text-[#00f0ff] rounded-lg hover:text-white hover:bg-[#00f0ff]/40 transition-all flex items-center justify-center border border-[#00f0ff]/30 shadow-inner cursor-pointer ${
                          currentDirection === 'L' ? 'bg-[#00f0ff]/40 text-white' : ''
                        }`}
                      >
                        <span className="material-symbols-outlined text-[32px]">keyboard_arrow_right</span>
                      </button>
                    </div>
                    <button
                      onClick={() => setDirection('F')}
                      className={`w-14 h-14 bg-[#323539] text-[#00f0ff] rounded-lg hover:text-white hover:bg-[#00f0ff]/40 transition-all flex items-center justify-center border border-[#00f0ff]/30 shadow-inner cursor-pointer ${
                        currentDirection === 'F' ? 'bg-[#00f0ff]/40 text-white' : ''
                      }`}
                    >
                      <span className="material-symbols-outlined text-[32px]">keyboard_arrow_down</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Settings Card */}
              <div className="tech-panel rounded-lg flex flex-col flex-1 overflow-hidden">
                <div className="bg-[#282a2e] px-4 py-2 border-b border-[#00f0ff]/20">
                  <span className="font-label-caps text-xs text-[#00f0ff]">DRIVE SYSTEMS</span>
                </div>
                <div className="p-6 space-y-6">
                  {/* Speed throttle slider */}
                  <div>
                    <div className="flex justify-between mb-3 font-telemetry text-xs text-[#b9cacb]">
                      <span>SPEED LIMITER</span>
                      <span className="text-[#00f0ff] glow-cyan">{speedMapping[speed] || speed}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1.0"
                      step="0.1"
                      value={speed}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value).toFixed(1);
                        setSpeed(val);
                        let cmd = '0';
                        if (val === '1.0') cmd = 'q';
                        else cmd = Math.floor(parseFloat(val) * 10).toString();
                        sendCommand(cmd);
                      }}
                      className="w-full h-1.5 appearance-none bg-[#323539] rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#00f0ff] [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(0,240,255,0.8)] cursor-pointer"
                    />
                  </div>

                  {/* Mode Grid selections */}
                  <div>
                    <span className="font-telemetry text-xs text-[#b9cacb] block mb-3">TRACTION MODE</span>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => handleModeChange('AUTO')}
                        className={`font-label-caps text-[10px] py-3 rounded border text-center transition-all cursor-pointer ${
                          currentMode === 'AUTO'
                            ? 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff] tech-active glow-cyan'
                            : 'bg-[#191c1f] text-[#b9cacb] border-[#3b494b]/30 hover:border-[#00f0ff]/50'
                        }`}
                      >
                        AUTO
                      </button>
                      <button
                        onClick={() => handleModeChange('MANUAL')}
                        className={`font-label-caps text-[10px] py-3 rounded border text-center transition-all cursor-pointer ${
                          currentMode === 'MANUAL'
                            ? 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff] tech-active glow-cyan'
                            : 'bg-[#191c1f] text-[#b9cacb] border-[#3b494b]/30 hover:border-[#00f0ff]/50'
                        }`}
                      >
                        MANUAL
                      </button>
                      <button
                        onClick={() => handleModeChange('AI')}
                        className={`font-label-caps text-[10px] py-3 rounded border text-center transition-all cursor-pointer ${
                          currentMode === 'AI'
                            ? 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff] tech-active glow-cyan'
                            : 'bg-[#191c1f] text-[#b9cacb] border-[#3b494b]/30 hover:border-[#00f0ff]/50'
                        }`}
                      >
                        AI
                      </button>
                      <button
                        onClick={() => handleModeChange('AI2')}
                        className={`font-label-caps text-[10px] py-3 rounded border text-center transition-all cursor-pointer ${
                          currentMode === 'AI2'
                            ? 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff] tech-active glow-cyan'
                            : 'bg-[#191c1f] text-[#b9cacb] border-[#3b494b]/30 hover:border-[#00f0ff]/50'
                        }`}
                      >
                        AI - 2
                      </button>
                      <button
                        onClick={handleRecordToggle}
                        className={`font-label-caps text-[10px] py-3 rounded border text-center transition-all col-span-2 cursor-pointer ${
                          isRecording
                            ? 'bg-[#ffb4ab]/20 text-[#ffb4ab] border-[#ffb4ab] glow-status'
                            : 'bg-[#191c1f] text-[#b9cacb] border-[#3b494b]/30 hover:border-[#00f0ff]/50'
                        }`}
                      >
                        RECORD
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Logs card */}
          <div className="h-48 tech-panel rounded-lg flex flex-col shrink-0 overflow-hidden">
            <div className="bg-[#282a2e] px-4 py-2 border-b border-[#00f0ff]/20 flex justify-between items-center">
              <span className="font-label-caps text-xs text-[#00f0ff]">SYSTEM LOG</span>
              <button className="font-telemetry text-xs text-[#b9cacb] hover:text-[#00f0ff] flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px]">filter_list</span> FILTER
              </button>
            </div>
            <div className="p-4 font-telemetry text-[13px] text-[#b9cacb] space-y-1.5 overflow-y-auto bg-[#0c0e12]/50 flex-1">
              {logs.map((log, idx) => (
                <div className="flex gap-6" key={idx}>
                  <span className="text-[#00f0ff]/60 w-28 shrink-0">[{log.time}]</span>
                  <span className="text-[#e1e2e7]">{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>

      {/* Confirmation Modal */}
      {confirmModal.show && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="tech-panel rounded-lg p-6 max-w-sm w-full mx-4 border border-[#00f0ff]/30 shadow-[0_0_20px_rgba(0,240,255,0.2)]">
            <h3 className="font-headline-md text-[#00f0ff] text-[18px] mb-4 glow-cyan flex items-center gap-2">
              <span className="material-symbols-outlined">warning</span>
              SYSTEM OVERRIDE
            </h3>
            <p className="font-body-md text-[#b9cacb] mb-6">{confirmModal.msg}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmModal({ show: false, msg: '' })}
                className="bg-[#191c1f] text-[#b9cacb] font-label-caps text-xs px-4 py-2 rounded border border-[#3b494b]/30 hover:border-[#00f0ff]/50 transition-colors cursor-pointer"
              >
                CANCEL
              </button>
              <button
                onClick={() => {
                  if (confirmModal.onConfirm) confirmModal.onConfirm();
                }}
                className="bg-[#00f0ff]/10 text-[#00f0ff] font-label-caps text-xs px-4 py-2 rounded border border-[#00f0ff] tech-active glow-cyan hover:bg-[#00f0ff]/30 transition-colors cursor-pointer"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Gamepad Setup Modal */}
      {joyModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="tech-panel rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden border border-[#00f0ff]/30 shadow-[0_0_20px_rgba(0,240,255,0.2)]">
            <div className="bg-[#282a2e] px-6 py-4 border-b border-[#00f0ff]/20 flex justify-between items-center">
              <span className="font-label-caps text-xs text-[#00f0ff] glow-cyan">CONTROLLER CONFIGURATION</span>
              <button
                onClick={() => setJoyModalOpen(false)}
                className="text-[#b9cacb] hover:text-[#00f0ff] transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="flex-1 p-6 overflow-y-auto flex flex-col xl:flex-row gap-6 bg-[#191c1f]">
              <div className="flex-1 tech-panel rounded-lg flex flex-col relative overflow-hidden items-center justify-center p-6 bg-[#0c0e12]/50">
                <div className="bg-[#282a2e]/80 backdrop-blur-md px-4 py-2 border-b border-[#00f0ff]/20 flex justify-between items-center z-10 absolute top-0 left-0 right-0">
                  <span className="font-label-caps text-xs text-[#00f0ff] glow-cyan">VISUALIZER: USB GAMEPAD</span>
                  <span className={`font-telemetry text-xs ${gamepadConnected ? 'text-[#00f0ff] glow-cyan' : 'text-[#ffb4ab]'}`}>
                    {gamepadConnected ? `CONNECTED: ${gamepadId}` : 'DISCONNECTED'}
                  </span>
                </div>
                <img
                  src="/gamepad.png"
                  className={`max-w-full max-h-[300px] object-contain transition-opacity duration-300 ${gamepadConnected ? 'opacity-100' : 'opacity-50'}`}
                  alt="Gamepad"
                />
                <div className="absolute bottom-4 left-4 font-telemetry text-xs text-[#00f0ff] bg-[#0c0e12]/80 p-3 rounded-lg border border-[#00f0ff]/30 backdrop-blur-md shadow-lg">
                  <span className="block opacity-50 text-[10px] mb-1">INSTRUCTIONS</span>
                  1. Connect your USB Joystick.<br />
                  2. Click on a field on the right.<br />
                  3. Press a button on your controller.
                </div>
              </div>
              <div className="w-full xl:w-80 flex flex-col gap-6 shrink-0">
                <div className="tech-panel rounded-lg flex flex-col overflow-hidden bg-[#0c0e12]/50">
                  <div className="bg-[#282a2e] px-4 py-2 border-b border-[#00f0ff]/20">
                    <span className="font-label-caps text-xs text-[#00f0ff]">BUTTON MAPPING</span>
                  </div>
                  <div className="p-6 space-y-4">
                    {['F', 'B', 'L', 'R', 'S'].map(dir => {
                      const dirLabel: Record<string, string> = {
                        F: 'FORWARD (DOWN)',
                        B: 'BACKWARD (UP)',
                        L: 'TURN LEFT',
                        R: 'TURN RIGHT',
                        S: 'STOP'
                      };
                      return (
                        <div key={dir}>
                          <label className="font-telemetry text-xs text-[#b9cacb] block mb-1">
                            {dirLabel[dir]}
                          </label>
                          <input
                            type="text"
                            value={activeMappingInput === dir ? 'Waiting for input...' : gamepadMappings[dir] || ''}
                            onFocus={() => setActiveMappingInput(dir)}
                            onBlur={() => {
                              if (activeMappingInput === dir) setActiveMappingInput(null);
                            }}
                            readOnly
                            className={`w-full bg-[#191c1f] border rounded p-2 text-white focus:border-[#00f0ff] outline-none font-telemetry text-xs cursor-pointer ${
                              activeMappingInput === dir ? 'border-[#00f0ff]' : 'border-[#3b494b]/30'
                            }`}
                          />
                        </div>
                      );
                    })}
                    <button
                      onClick={saveGamepadConfig}
                      className="w-full mt-4 bg-[#00f0ff]/10 text-[#00f0ff] font-label-caps text-xs py-3 rounded border border-[#00f0ff] tech-active hover:bg-[#00f0ff]/30 transition-all glow-cyan cursor-pointer"
                    >
                      SAVE CONFIGURATION
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
