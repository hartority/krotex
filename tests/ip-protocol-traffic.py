"""Send and observe raw IPv4 GRE packets without requiring a tunnel or Scapy."""
import socket
import sys
from pathlib import Path

if sys.argv[1] == "serve":
    log = Path(sys.argv[2])
    with socket.socket(socket.AF_INET, socket.SOCK_RAW, 47) as sock, log.open("w") as output:
        Path(str(log) + ".ready").touch()
        while True:
            packet, _ = sock.recvfrom(65535)
            payload = packet[(packet[0] & 15) * 4:]
            if payload.startswith(b"krotex-test:"):
                output.write(payload.decode("ascii") + "\n")
                output.flush()
elif sys.argv[1] == "dns":
    query = bytes.fromhex("12340100000100000000000006646576696365066b726f74657804746573740000010001")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(1)
        sock.connect((sys.argv[2], 53))
        sock.send(query)
        try:
            sock.recv(4096)
        except (TimeoutError, ConnectionRefusedError):
            sys.exit(1)
else:
    with socket.socket(socket.AF_INET, socket.SOCK_RAW, 47) as sock:
        sock.sendto(("krotex-test:" + sys.argv[3]).encode("ascii"), (sys.argv[2], 0))
