from django.http import HttpResponse, StreamingHttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
import threading
import cv2
import numpy as np
from ultralytics import YOLO
import time
import random
import os
import datetime

model = YOLO('yolov8n.pt')

latest_frame = b''
frame_condition = threading.Condition()

total_bytes = 0
last_calc_time = time.time()
current_bandwidth = 0.0

is_recording = False
video_writer = None

system_logs = [
    {"time": time.strftime('%H:%M:%S'), "message": "SYS: Server started."}
]

def add_log(message):
    global system_logs
    system_logs.append({"time": time.strftime('%H:%M:%S'), "message": message})
    if len(system_logs) > 50:
        system_logs.pop(0)


@csrf_exempt
def upload_frame(request):
    global latest_frame, total_bytes, last_calc_time, current_bandwidth, is_recording, video_writer
    if request.method == 'POST':
        with frame_condition:
            latest_frame = request.body
            
            # Bandwidth calculation
            total_bytes += len(latest_frame)
            now = time.time()
            dt = now - last_calc_time
            if dt >= 1.0:
                current_bandwidth = (total_bytes * 8) / (dt * 1000000)
                total_bytes = 0
                last_calc_time = now
                
            if is_recording and video_writer is not None:
                nparr = np.frombuffer(latest_frame, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if img is not None:
                    img_resized = cv2.resize(img, (320, 240))
                    video_writer.write(img_resized)
                
            frame_condition.notify_all()
        return HttpResponse("Frame received", status=200)
    return HttpResponse("Only POST allowed", status=405)

def telemetry(request):
    # Local network latency is usually small, we add some random jitter
    latency = random.randint(25, 65)
    return JsonResponse({
        "latency": latency,
        "bandwidth": round(current_bandwidth, 2)
    })

def toggle_record(request):
    global is_recording, video_writer
    status = request.GET.get('status', 'false').lower() == 'true'
    
    if status and not is_recording:
        is_recording = True
        os.makedirs('recordings', exist_ok=True)
        filename = f"recordings/mision_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.avi"
        fourcc = cv2.VideoWriter_fourcc(*'XVID')
        video_writer = cv2.VideoWriter(filename, fourcc, 15.0, (320, 240))
        add_log(f"SYS: Recording started. File: {filename}")
    elif not status and is_recording:
        is_recording = False
        if video_writer:
            video_writer.release()
            video_writer = None
        add_log("SYS: Recording stopped.")
            
    return JsonResponse({"recording": is_recording})

def stream_puller():
    import urllib.request
    global latest_frame, total_bytes, last_calc_time, current_bandwidth, is_recording, video_writer
    stream_url = 'http://192.168.1.171:81/stream'
    print(f"Starting stream puller from {stream_url}")
    
    while True:
        try:
            req = urllib.request.urlopen(stream_url, timeout=10)
            print("Conectado exitosamente al stream del ESP32")
            bytes_data = b''
            while True:
                chunk = req.read(4096)
                if not chunk:
                    print("No hay más datos en el stream")
                    break
                bytes_data += chunk
                
                while True:
                    cl_index = bytes_data.lower().find(b'content-length:')
                    if cl_index == -1:
                        if len(bytes_data) > 65536:
                            bytes_data = b''
                        break
                    
                    line_end = bytes_data.find(b'\r\n', cl_index)
                    if line_end == -1:
                        break
                    
                    try:
                        cl_line = bytes_data[cl_index:line_end]
                        content_length = int(cl_line.split(b':')[1].strip())
                    except (ValueError, IndexError):
                        bytes_data = bytes_data[line_end + 2:]
                        continue
                    
                    header_end = bytes_data.find(b'\r\n\r\n', cl_index)
                    if header_end == -1:
                        break
                    
                    start_of_image = header_end + 4
                    if len(bytes_data) >= start_of_image + content_length:
                        jpg = bytes_data[start_of_image : start_of_image + content_length]
                        bytes_data = bytes_data[start_of_image + content_length:]
                        
                        with frame_condition:
                            latest_frame = jpg
                            
                            # Bandwidth calculation
                            total_bytes += len(jpg)
                            now = time.time()
                            dt = now - last_calc_time
                            if dt >= 1.0:
                                current_bandwidth = (total_bytes * 8) / (dt * 1000000)
                                total_bytes = 0
                                last_calc_time = now
                                
                            # Recording
                            if is_recording and video_writer is not None:
                                nparr = np.frombuffer(jpg, np.uint8)
                                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                                if img is not None:
                                    img_resized = cv2.resize(img, (320, 240))
                                    video_writer.write(img_resized)
                                    
                            frame_condition.notify_all()
                    else:
                        break
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"Connection error in stream puller: {e}. Retrying in 1s...")
            time.sleep(1)
        except Exception as e:
            # Catch other exceptions like http.client.IncompleteRead, RemoteDisconnected
            print(f"Stream interrupted: {e}. Reconnecting...")
            time.sleep(0.1)

# Start the thread unconditionally to ensure it runs under ASGI/Daphne/runserver
t = threading.Thread(target=stream_puller, daemon=True)
t.start()

# AI Navigation State Machine globals
ai_nav_active = False
ai_nav_state = 'IDLE' # IDLE, SCANNING, LOCATING, ALIGNING, APPROACHING, COMPLETED
target_qr = None
last_sent_cmd = None
last_seen_ratio = 0.0
last_seen_time = 0.0
qr_detector = cv2.QRCodeDetector()
last_cmd_time = 0.0
esp_ws_connection = None
esp_ws_lock = threading.Lock()

def websocket_keepalive_worker():
    global esp_ws_connection
    esp_ip = '192.168.1.99'
    ws_url = f"ws://{esp_ip}:81"
    from websocket import create_connection
    
    while True:
        try:
            with esp_ws_lock:
                if esp_ws_connection is None:
                    add_log("WS Worker: Connecting to ESP8266...")
                    esp_ws_connection = create_connection(ws_url, timeout=2.0)
                    add_log("WS Worker: Connected successfully.")
                else:
                    # Ping to verify socket connection
                    esp_ws_connection.ping()
        except Exception as e:
            add_log(f"WS Worker: Connection lost or failed: {e}. Reconnecting in 3s...")
            with esp_ws_lock:
                if esp_ws_connection:
                    try:
                        esp_ws_connection.close()
                    except:
                        pass
                    esp_ws_connection = None
        time.sleep(3.0)

threading.Thread(target=websocket_keepalive_worker, daemon=True).start()

# Circular scanning state variables
scanned_qrs = set()
scan_start_time = 0.0
SCAN_DURATION = 8.0  # ~8 seconds for 2 full turns

def reset_ai_navigation():
    global ai_nav_active, ai_nav_state, target_qr, last_sent_cmd, last_seen_ratio, last_seen_time, scanned_qrs, scan_start_time
    ai_nav_active = True
    ai_nav_state = 'SCANNING'
    target_qr = None
    last_sent_cmd = None
    last_seen_ratio = 0.0
    last_seen_time = time.time()
    scanned_qrs = set()
    scan_start_time = time.time()
    threading.Thread(target=send_esp_command_bg, args=('R',), daemon=True).start()
    last_sent_cmd = 'R'
    add_log("AI: Started scanning (2 turns) for circular QRs...")

def process_ai_frame(frame_bytes, use_ai, use_ai2, use_auto):
    global ai_nav_active, ai_nav_state, target_qr, last_sent_cmd, last_seen_ratio, last_seen_time, scanned_qrs, scan_start_time, last_cmd_time
    
    # 1. AUTO Mode: Blue Cap Tracking and Following (5cm distance target)
    if use_auto:
        nparr = np.frombuffer(frame_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return frame_bytes
            
        h, w, _ = img.shape
        center_x = w / 2
        
        # Convert BGR to HSV
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        
        # Define range of blue color in HSV
        lower_blue = np.array([90, 60, 50])
        upper_blue = np.array([135, 255, 255])
        
        mask = cv2.inRange(hsv, lower_blue, upper_blue)
        
        # Morphological opening/closing to remove small noise
        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        
        # Find contours
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        largest_contour = None
        max_area = 0
        for c in contours:
            area = cv2.contourArea(c)
            if area > max_area:
                max_area = area
                largest_contour = c
                
        status_text = "AUTO: SEARCHING BLUE CAP"
        hud_color = (255, 128, 0) # Orange
        
        if largest_contour is not None and max_area > 120:
            x, y, cw, ch = cv2.boundingRect(largest_contour)
            cx = x + cw // 2
            cy = y + ch // 2
            ratio = cw / w # Width ratio relative to screen width
            
            # Draw bounding box and center dot
            cv2.rectangle(img, (x, y), (x + cw, y + ch), (255, 255, 0), 2)
            cv2.circle(img, (cx, cy), 6, (0, 0, 255), -1)
            cv2.putText(img, f"BLUE CAP (Area: {int(max_area)})", (x, y - 10), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 2)
            
            # Target width ratio corresponding to ~5cm distance for a 2.5cm cap
            target_min = 0.22
            target_max = 0.30
            threshold = w * 0.14 # 14% tolerance for centering to avoid oscillations
            
            # 1. Center alignment check (Inverted to correct tracking direction)
            if cx < center_x - threshold:
                command = 'R'
                status_text = "AUTO: ALIGNING LEFT"
            elif cx > center_x + threshold:
                command = 'L'
                status_text = "AUTO: ALIGNING RIGHT"
            else:
                # 2. Distance alignment check
                if ratio < target_min:
                    command = 'B'
                    status_text = f"AUTO: APPROACHING ({ratio*100:.1f}%)"
                elif ratio > target_max:
                    command = 'F'
                    status_text = f"AUTO: BACKING UP ({ratio*100:.1f}%)"
                else:
                    command = 'S'
                    status_text = "AUTO: HOLDING DISTANCE (5cm)"
                    hud_color = (0, 255, 0) # Green
            
            # Send movement command with debouncing & cooldown
            now = time.time()
            if command == 'S':
                if last_sent_cmd != 'S':
                    threading.Thread(target=send_esp_command_bg, args=('S',), daemon=True).start()
                    last_sent_cmd = 'S'
                    last_cmd_time = now
            elif last_sent_cmd != command and (now - last_cmd_time > 0.25):
                threading.Thread(target=send_esp_command_bg, args=(command,), daemon=True).start()
                last_sent_cmd = command
                last_cmd_time = now
        else:
            # Stop if target cap is not found
            if last_sent_cmd != 'S':
                threading.Thread(target=send_esp_command_bg, args=('S',), daemon=True).start()
                last_sent_cmd = 'S'
                last_cmd_time = time.time()
                add_log("AI (Auto): Lost target cap. Stopping.")
                
        # Draw HUD Banner
        cv2.rectangle(img, (0, 0), (w, 35), (0, 0, 0), -1)
        cv2.putText(img, status_text, (10, 22), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, hud_color, 2)
                    
        # Centering visual lines
        threshold = w * 0.14
        cv2.line(img, (int(center_x - threshold), 0), (int(center_x - threshold), h), (255, 255, 255), 1)
        cv2.line(img, (int(center_x + threshold), 0), (int(center_x + threshold), h), (255, 255, 255), 1)
        
        ret, buffer = cv2.imencode('.jpg', img)
        if ret:
            return buffer.tobytes()
        return frame_bytes

    # 2. AI-2 Mode: QR Navigation State Machine
    if use_ai2:
        if not ai_nav_active:
            reset_ai_navigation()

        nparr = np.frombuffer(frame_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return frame_bytes
            
        h, w, _ = img.shape
        center_x = w / 2
        threshold = w * 0.12 # 12% tolerance for centering
        
        data, points, _ = qr_detector.detectAndDecode(img)
        
        if points is not None and len(points) > 0 and data:
            pts = points[0].astype(np.int32)
            
            color = (0, 165, 255) # Orange
            if ai_nav_state == 'SCANNING' or data == target_qr:
                color = (0, 255, 0) # Green
                
            cv2.polylines(img, [pts], True, color, 2)
            
            cx = int(np.mean(pts[:, 0]))
            cy = int(np.mean(pts[:, 1]))
            qr_width = np.max(pts[:, 0]) - np.min(pts[:, 0])
            
            cv2.circle(img, (cx, cy), 5, (0, 0, 255), -1)
            cv2.putText(img, f"QR: {data}", (pts[0][0], pts[0][1] - 10), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
            
            if ai_nav_state == 'SCANNING':
                if data not in scanned_qrs:
                    scanned_qrs.add(data)
                    add_log(f"AI: Discovered QR: '{data}'")
                    
            elif ai_nav_state == 'LOCATING' and data == target_qr:
                ai_nav_state = 'ALIGNING'
                last_seen_ratio = qr_width / w
                last_seen_time = time.time()
                threading.Thread(target=send_esp_command_bg, args=('S',), daemon=True).start()
                last_sent_cmd = 'S'
                add_log(f"AI: Located target '{data}'. Aligning...")
                
            elif ai_nav_state == 'ALIGNING' and data == target_qr:
                last_seen_ratio = qr_width / w
                last_seen_time = time.time()
                if cx < center_x - threshold:
                    if last_sent_cmd != 'L':
                        threading.Thread(target=send_esp_command_bg, args=('L',), daemon=True).start()
                        last_sent_cmd = 'L'
                elif cx > center_x + threshold:
                    if last_sent_cmd != 'R':
                        threading.Thread(target=send_esp_command_bg, args=('R',), daemon=True).start()
                        last_sent_cmd = 'R'
                else:
                    ai_nav_state = 'APPROACHING'
                    threading.Thread(target=send_esp_command_bg, args=('F',), daemon=True).start()
                    last_sent_cmd = 'F'
                    add_log(f"AI: Aligned with target '{data}'. Approaching...")
                    
            elif ai_nav_state == 'APPROACHING' and data == target_qr:
                last_seen_ratio = qr_width / w
                last_seen_time = time.time()
                if last_seen_ratio > 0.42:
                    ai_nav_state = 'COMPLETED'
                    threading.Thread(target=send_esp_command_bg, args=('S',), daemon=True).start()
                    last_sent_cmd = 'S'
                    add_log(f"AI: Entered house for target '{data}'. Mission completed!")
                else:
                    if cx < center_x - threshold:
                        if last_sent_cmd != 'L':
                            threading.Thread(target=send_esp_command_bg, args=('L',), daemon=True).start()
                            last_sent_cmd = 'L'
                    elif cx > center_x + threshold:
                        if last_sent_cmd != 'R':
                            threading.Thread(target=send_esp_command_bg, args=('R',), daemon=True).start()
                            last_sent_cmd = 'R'
                    else:
                        if last_sent_cmd != 'F':
                            threading.Thread(target=send_esp_command_bg, args=('F',), daemon=True).start()
                            last_sent_cmd = 'F'

        # --- Timeout & Search Transitions ---
        now = time.time()
        if ai_nav_state == 'SCANNING':
            elapsed = now - scan_start_time
            remaining = max(0.0, SCAN_DURATION - elapsed)
            if remaining <= 0:
                if len(scanned_qrs) > 0:
                    import random
                    target_qr = random.choice(list(scanned_qrs))
                    ai_nav_state = 'LOCATING'
                    if last_sent_cmd != 'R':
                        threading.Thread(target=send_esp_command_bg, args=('R',), daemon=True).start()
                        last_sent_cmd = 'R'
                    add_log(f"AI: 2 turns completed. Found: {list(scanned_qrs)}. Target chosen at random: '{target_qr}'")
                else:
                    scan_start_time = now
                    add_log("AI: No QRs found in 2 turns. Scanning again...")
                    
        elif ai_nav_state == 'LOCATING':
            if now - last_seen_time > 10.0:
                ai_nav_state = 'SCANNING'
                scan_start_time = now
                scanned_qrs = set()
                if last_sent_cmd != 'R':
                    threading.Thread(target=send_esp_command_bg, args=('R',), daemon=True).start()
                    last_sent_cmd = 'R'
                add_log("AI: Failed to locate target. Scanning again...")
                
        elif ai_nav_state == 'ALIGNING':
            if now - last_seen_time > 2.0:
                ai_nav_state = 'LOCATING'
                if last_sent_cmd != 'R':
                    threading.Thread(target=send_esp_command_bg, args=('R',), daemon=True).start()
                    last_sent_cmd = 'R'
                add_log(f"AI: Target lost during alignment. Locating again...")
                
        elif ai_nav_state == 'APPROACHING':
            if now - last_seen_time > 1.5:
                if last_seen_ratio > 0.28:
                    ai_nav_state = 'COMPLETED'
                    threading.Thread(target=send_esp_command_bg, args=('S',), daemon=True).start()
                    last_sent_cmd = 'S'
                    add_log(f"AI: QR lost but was close. Assuming entered house. Mission completed!")
                else:
                    ai_nav_state = 'LOCATING'
                    if last_sent_cmd != 'R':
                        threading.Thread(target=send_esp_command_bg, args=('R',), daemon=True).start()
                        last_sent_cmd = 'R'
                    add_log(f"AI: Target lost during approach. Locating again...")

        # HUD Drawing
        cv2.rectangle(img, (0, 0), (w, 35), (0, 0, 0), -1)
        status_color = (0, 255, 255)
        
        if ai_nav_state == 'SCANNING':
            elapsed = now - scan_start_time
            remaining = max(0.0, SCAN_DURATION - elapsed)
            status_text = f"SCANNING (Remaining: {remaining:.1f}s | Found: {len(scanned_qrs)})"
        elif ai_nav_state == 'LOCATING':
            status_text = f"LOCATING TARGET: {target_qr}"
        elif ai_nav_state == 'ALIGNING':
            status_text = f"ALIGNING WITH: {target_qr}"
        elif ai_nav_state == 'APPROACHING':
            status_text = f"APPROACHING: {target_qr}"
        elif ai_nav_state == 'COMPLETED':
            status_text = "COMPLETED!"
            status_color = (0, 255, 0)
        else:
            status_text = f"STATE: {ai_nav_state}"

        cv2.putText(img, status_text, (10, 22), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, status_color, 2)
        
        if target_qr and ai_nav_state != 'SCANNING':
            cv2.putText(img, f"TARGET: {target_qr}", (w - 180, 22), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
                        
        # Target center lines
        if ai_nav_state in ['ALIGNING', 'APPROACHING']:
            cv2.line(img, (int(center_x - threshold), 0), (int(center_x - threshold), h), (180, 180, 180), 1)
            cv2.line(img, (int(center_x + threshold), 0), (int(center_x + threshold), h), (180, 180, 180), 1)
        
        if ai_nav_state == 'COMPLETED':
            cv2.rectangle(img, (30, int(h/2 - 25)), (w - 30, int(h/2 + 25)), (0, 128, 0), -1)
            cv2.putText(img, f"ENTERED: {target_qr}", (50, int(h/2 + 8)), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                        
        ret, buffer = cv2.imencode('.jpg', img)
        if ret:
            return buffer.tobytes()
        return frame_bytes

    # 2. Clean up AI-2 state if disabled
    if ai_nav_active:
        ai_nav_active = False
        ai_nav_state = 'IDLE'
        threading.Thread(target=send_esp_command_bg, args=('S',), daemon=True).start()
        add_log("AI: Navigation disabled. Robot stopped.")

    # 3. AI-1 Mode: Original YOLO Person Detection
    if use_ai:
        nparr = np.frombuffer(frame_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is not None:
            results = model.predict(img, classes=[0], verbose=False)
            annotated_img = results[0].plot()
            ret, buffer = cv2.imencode('.jpg', annotated_img)
            if ret:
                return buffer.tobytes()
        return frame_bytes

    # 4. Standard Mode: Raw Video Frame
    return frame_bytes

def gen_frames(use_ai=False, use_ai2=False, use_auto=False):
    global latest_frame
    while True:
        with frame_condition:
            if not frame_condition.wait(timeout=1.0):
                continue
            frame_bytes = latest_frame
        
        if frame_bytes:
            processed_bytes = process_ai_frame(frame_bytes, use_ai, use_ai2, use_auto)
            yield (b'\r\n--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + processed_bytes + b'\r\n')

def video_feed(request):
    use_ai = request.GET.get('ai', 'false').lower() == 'true'
    use_ai2 = request.GET.get('ai2', 'false').lower() == 'true'
    use_auto = request.GET.get('auto', 'false').lower() == 'true'
    return StreamingHttpResponse(gen_frames(use_ai, use_ai2, use_auto),
                                 content_type='multipart/x-mixed-replace; boundary=frame')

from django.http import HttpResponse

def single_frame(request):
    global latest_frame
    use_ai = request.GET.get('ai', 'false').lower() == 'true'
    use_ai2 = request.GET.get('ai2', 'false').lower() == 'true'
    use_auto = request.GET.get('auto', 'false').lower() == 'true'
    reset = request.GET.get('reset', 'false').lower() == 'true'
    
    if reset:
        reset_ai_navigation()
        
    if latest_frame:
        processed_bytes = process_ai_frame(latest_frame, use_ai, use_ai2, use_auto)
        response = HttpResponse(processed_bytes, content_type='image/jpeg')
        response['X-AI-State'] = ai_nav_state
        response['X-AI-Target'] = target_qr or ''
        response['Access-Control-Expose-Headers'] = 'X-AI-State, X-AI-Target'
        return response
    else:
        return HttpResponse("No frame available", status=404)

def send_esp_command_bg(state, duration=None):
    global esp_ws_connection
    esp_ip = '192.168.1.99'  # TODO: Replace with your ESP8266 IP
    ws_url = f"ws://{esp_ip}:81"
    
    def send_ws_payload(payload):
        global esp_ws_connection
        from websocket import create_connection
        for attempt in range(2):
            try:
                if esp_ws_connection is None:
                    add_log("WS: Establishing persistent WebSocket connection...")
                    esp_ws_connection = create_connection(ws_url, timeout=2.0)
                esp_ws_connection.send(payload)
                return True
            except Exception as e:
                add_log(f"WS Attempt {attempt+1} failed: {e}. Reconnecting...")
                if esp_ws_connection:
                    try:
                        esp_ws_connection.close()
                    except:
                        pass
                    esp_ws_connection = None
        return False

    try:
        with esp_ws_lock:
            success = send_ws_payload(state)
            if success:
                add_log(f"NAV: Command {state} sent to rover via persistent WS.")
            else:
                add_log(f"ERR: Failed to send command {state} to ESP via persistent WS after retries.")
        
        if duration and state in ['F', 'B', 'L', 'R']:
            time.sleep(duration)
            with esp_ws_lock:
                send_ws_payload('S')
                add_log(f"NAV: Auto-stopped command {state} after {duration}s.")
    except Exception as e:
        add_log(f"ERR: Error in send_esp_command_bg: {e}")

def control_rover(request):
    state = request.GET.get('State', 'S')
    
    # Execute ESP request in a background thread to prevent blocking Daphne/ASGI
    threading.Thread(target=send_esp_command_bg, args=(state,), daemon=True).start()
    
    return JsonResponse({"status": "ok", "command": state})

def get_logs(request):
    return JsonResponse({"logs": system_logs})

import json
import urllib.request
from vosk import Model, KaldiRecognizer

# Initialize Vosk Model (English)
MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'vosk-model-en-us-0.22-lgraph')
vosk_model = None
if os.path.exists(MODEL_DIR):
    try:
        vosk_model = Model(MODEL_DIR)
        print("Vosk English model loaded successfully.")
    except Exception as e:
        print(f"Error loading Vosk model: {e}")
else:
    print(f"Vosk model directory not found at {MODEL_DIR}")

@csrf_exempt
def voice_control(request):
    if request.method == 'POST':
        if request.headers.get('Content-Type') == 'application/octet-stream':
            if not vosk_model:
                return JsonResponse({"status": "error", "message": "Vosk offline model not loaded on server"}, status=500)
            try:
                rec = KaldiRecognizer(vosk_model, 16000)
                rec.AcceptWaveform(request.body)
                res = json.loads(rec.FinalResult())
                text = res.get('text', '').strip()
            except Exception as e:
                add_log(f"ERR: Vosk offline recognition failed: {e}")
                return JsonResponse({"status": "error", "message": f"Vosk failed: {e}"}, status=500)
        else:
            try:
                data = json.loads(request.body)
                text = data.get('text', '').strip()
            except json.JSONDecodeError:
                return JsonResponse({"status": "error", "message": "Invalid JSON"}, status=400)
        
        if not text:
            return JsonResponse({"status": "error", "message": "No voice command detected"}, status=400)
        
        # Fast local pattern matching for common voice commands (Spanish & English)
        text_lower = text.lower()
        command = None
        if any(w in text_lower for w in ['avanza', 'avanzar', 'adelante', 'frente', 'forward', 'advance', 'front', 'go ahead', 'ahead', 'go', 'drive', 'move']):
            command = 'B'
        elif any(w in text_lower for w in ['retrocede', 'retroceder', 'atrás', 'atras', 'reversa', 'back', 'reverse', 'backward']):
            command = 'F'
        elif any(w in text_lower for w in ['derecha', 'right']):
            command = 'L'
        elif any(w in text_lower for w in ['izquierda', 'left']):
            command = 'R'
        elif any(w in text_lower for w in ['para', 'parar', 'detén', 'detente', 'detenerse', 'alto', 'stop', 'quieto', 'halt', 'stay', 'freeze']):
            command = 'S'
        elif any(w in text_lower for w in ['bocina', 'claxon', 'pitar', 'pita', 'horn', 'beep', 'honk']):
            command = 'V'
        elif any(w in text_lower for w in ['prender luces', 'encender luces', 'luces encendidas', 'prende luces', 'enciende luces', 'luces', 'lights on', 'light on', 'turn on lights']):
            command = 'W'
        elif any(w in text_lower for w in ['apagar luces', 'apaga luces', 'quitar luces', 'luces apagadas', 'lights off', 'light off', 'turn off lights']):
            command = 'w'

        if command:
            threading.Thread(target=send_esp_command_bg, args=(command,), kwargs={"duration": 2.0}, daemon=True).start()
            add_log(f"VOICE (Local): Interpreted \"{text}\" -> Command {command}")
            return JsonResponse({
                "status": "success",
                "text_heard": text,
                "command_executed": command
            })
            
        # Fallback to Cerebras API for AI interpretation
        api_key = ""
        if not api_key or api_key == "TU_CEREBRAS_API_KEY_AQUI":
            add_log("ERR: Cerebras API Key no configurada en views.py.")
            return JsonResponse({"status": "error", "message": "Por favor escribe tu API key de Cerebras en views.py"}, status=500)
            
        url = "https://api.cerebras.ai/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        system_prompt = (
            "Eres el procesador de comandos de voz de un robot de exploración. "
            "Analiza el texto del usuario y responde ÚNICAMENTE con una de las siguientes letras "
            "correspondientes al movimiento que pide. No agregues explicaciones, ni puntos, ni texto adicional:\n"
            "F - Avanzar / Adelante / Ir al frente / Camina hacia adelante\n"
            "B - Retroceder / Atrás / Reversa\n"
            "R - Girar a la derecha / Derecha / Doblar a la derecha\n"
            "L - Girar a la izquierda / Izquierda / Doblar a la izquierda\n"
            "S - Parar / Detenerse / Alto / Quieto / Stop\n"
            "V - Tocar bocina / sonar claxon / pitar / claxon\n"
            "W - Encender luces / prender luces / luz encendida\n"
            "w - Apagar luces / quitar luces / luz apagada\n"
            "Si no entiendes el comando o no corresponde a ninguna acción, responde con 'S' (parar)."
        )
        
        payload = {
            "model": "llama3.1-8b",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text}
            ],
            "temperature": 0.0,
            "max_tokens": 5
        }
        
        try:
            req = urllib.request.Request(
                url, 
                data=json.dumps(payload).encode('utf-8'), 
                headers=headers, 
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=4) as response:
                response_data = json.loads(response.read().decode('utf-8'))
                command = response_data['choices'][0]['message']['content'].strip()
                
            # Filter response down to valid commands
            if command not in ['F', 'B', 'L', 'R', 'S', 'V', 'W', 'w']:
                command = command.strip()[:1]
                if command not in ['F', 'B', 'L', 'R', 'S', 'V', 'W', 'w']:
                    command = 'S'
            
            # Send the command to the ESP8266
            threading.Thread(target=send_esp_command_bg, args=(command,), kwargs={"duration": 2.0}, daemon=True).start()
            
            add_log(f"VOICE (Cerebras): Interpreted \"{text}\" -> Command {command}")
            return JsonResponse({
                "status": "success",
                "text_heard": text,
                "command_executed": command
            })
            
        except Exception as e:
            add_log(f"ERR: Voice control API call failed: {e}")
            return JsonResponse({"status": "error", "message": str(e)}, status=500)
            
    return JsonResponse({"status": "error", "message": "Only POST allowed"}, status=405)



