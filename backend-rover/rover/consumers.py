import time
import numpy as np
import cv2
from channels.generic.websocket import WebsocketConsumer
import rover.views as views

class VideoConsumer(WebsocketConsumer):
    def connect(self):
        self.accept()
        print("ESP32 connected via WebSocket")

    def disconnect(self, close_code):
        print("ESP32 disconnected")

    def receive(self, text_data=None, bytes_data=None):
        print(f"Receive called. bytes_data length: {len(bytes_data) if bytes_data else 'None'}")
        try:
            if bytes_data:
                with views.frame_condition:
                    views.latest_frame = bytes_data
                    
                    # Bandwidth calculation
                    views.total_bytes += len(bytes_data)
                    now = time.time()
                    dt = now - views.last_calc_time
                    if dt >= 1.0:
                        views.current_bandwidth = (views.total_bytes * 8) / (dt * 1000000)
                        views.total_bytes = 0
                        views.last_calc_time = now
                        
                    if views.is_recording and views.video_writer is not None:
                        nparr = np.frombuffer(bytes_data, np.uint8)
                        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                        if img is not None:
                            img_resized = cv2.resize(img, (320, 240))
                            views.video_writer.write(img_resized)
                        
                    views.frame_condition.notify_all()
        except Exception as e:
            print(f"Error in VideoConsumer receive: {e}")
