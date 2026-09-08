#!/usr/bin/env python3
"""
Gaussian Splat HTTP server - serves PLY files and viewer
"""

import http.server
import socketserver
import json
from pathlib import Path

PORT = 8765
BASE_DIR = Path(__file__).parent
SHARP_DATA = BASE_DIR / "sharp_data"

class SplatHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)
    
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    
    def do_GET(self):
        if self.path == '/' or self.path == '/viewer':
            self.path = '/splat_viewer.html'
        
        if self.path == '/latest_splat':
            output_dirs = sorted(SHARP_DATA.glob("output_*"))
            if output_dirs:
                latest = output_dirs[-1]
                ply_files = list(latest.glob("*.ply"))
                if ply_files:
                    rel_path = ply_files[0].relative_to(BASE_DIR)
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "path": f"/{rel_path}",
                        "frame": latest.name,
                        "size_mb": ply_files[0].stat().st_size / 1024 / 1024
                    }).encode())
                    return
            self.send_error(404, "No splat files found")
            return
        
        if self.path == '/list_splats':
            splats = []
            for d in sorted(SHARP_DATA.glob("output_*")):
                for ply in d.glob("*.ply"):
                    splats.append({
                        "frame": d.name,
                        "path": f"/sharp_data/{d.name}/{ply.name}",
                        "size_mb": round(ply.stat().st_size / 1024 / 1024, 1)
                    })
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"splats": splats[-10:]}).encode())
            return
        
        return super().do_GET()

if __name__ == "__main__":
    print("="*50)
    print("  GAUSSIAN SPLAT VIEWER")
    print("="*50)
    print(f"\n  Open in browser: http://localhost:{PORT}")
    print(f"  Latest splat API: http://localhost:{PORT}/latest_splat\n")
    
    with socketserver.TCPServer(("", PORT), SplatHandler) as httpd:
        httpd.serve_forever()
