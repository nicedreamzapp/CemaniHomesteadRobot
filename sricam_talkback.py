import socket
import time
import math
import struct
import argparse
import sys

def generate_tone(duration_sec, current_seq, ts1, ts2, base_header):
    # 8000 Hz, 16-bit PCM little endian
    sample_rate = 8000
    num_samples = int(duration_sec * sample_rate)
    samples = []
    # Generate 440Hz sine wave, loud!
    for i in range(num_samples):
        val = int(30000 * math.sin(2 * math.pi * 440 * (i / sample_rate)))
        val = max(-32768, min(32767, val))
        samples.append(struct.pack('<h', val))
    
    audio_data = b''.join(samples)
    
    packets = []
    for i in range(0, len(audio_data), 256):
        chunk = audio_data[i:i+256]
        if len(chunk) < 256:
            chunk = chunk + b'\x00' * (256 - len(chunk))
            
        header = bytearray(base_header)
        
        # update seq
        struct.pack_into('<I', header, 4, current_seq)
        
        # update ts
        struct.pack_into('<I', header, 8, ts1)
        struct.pack_into('<I', header, 12, ts2)
        
        packets.append(header + chunk)
        
        current_seq += 1
        ts1 += 128
        ts2 += 128
        
    return packets

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", default="10.0.0.15", help="Camera IP")
    parser.add_argument("--port", type=int, default=51880, help="Camera UDP Port")
    parser.add_argument("--start", default="/tmp/talk_start.bin", help="TALK_START payload file")
    parser.add_argument("--stop", default="/tmp/talk_stop.bin", help="TALK_STOP payload file")
    parser.add_argument("--audio", default="/tmp/audio_packets.bin", help="Sample audio payload file")
    args = parser.parse_args()
    
    camera_addr = (args.ip, args.port)
    
    try:
        with open(args.start, "rb") as f:
            talk_start = f.read()
        with open(args.stop, "rb") as f:
            talk_stop = f.read()
        with open(args.audio, "rb") as f:
            first_packet = f.read(320)
            base_header = bytearray(first_packet[:64])
    except Exception as e:
        print(f"Error reading bin files: {e}")
        return
        
    base_seq = struct.unpack('<I', base_header[4:8])[0]
    base_ts1 = struct.unpack('<I', base_header[8:12])[0]
    base_ts2 = struct.unpack('<I', base_header[12:16])[0]
    
    print(f"Base Header Seq: {base_seq}, TS: {base_ts1}")
    
    packets = generate_tone(3.0, base_seq, base_ts1, base_ts2, base_header)
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("", args.port))
    
    print(f"Sending TALK_START to {camera_addr} from bound port {args.port}...")
    sock.sendto(talk_start, camera_addr)
    time.sleep(0.05)
    
    print(f"Streaming {len(packets)} audio packets (3s beep)...")
    
    start_time = time.perf_counter()
    for i, packet in enumerate(packets):
        target_time = start_time + (i * 0.016)
        sock.sendto(packet, camera_addr)
        
        now = time.perf_counter()
        sleep_time = target_time - now
        if sleep_time > 0:
            time.sleep(sleep_time)
            
    time.sleep(0.05)
    print(f"Sending TALK_STOP...")
    sock.sendto(talk_stop, camera_addr)
    print("Done.")

if __name__ == "__main__":
    main()
