#!/usr/bin/env python3
"""Observe one operator-requested lease retry on the prepaid loopback port.

No requests are sent to the lease route, no files are written, and no traffic,
headers, credentials, addresses or installation IDs are printed. Only a fixed
allowlist of response classifications leaves this process. Run as root on the
credits server, then retry in Core. Uses the Python standard library only.
"""
import argparse
import json
import re
import socket
import struct
import time
import urllib.request

PORT = 3109
ROUTE = b"POST /scheduler/koin/test/lease HTTP/1.1"
LIMIT = 16384
ERRORS = {
    "This Test wallet is already bound to another installation. Recover that installation or use a separately invited Test wallet": "HOST_BINDING_CONFLICT",
    "Test invitation required": "ACCOUNT_AUTH_REQUIRED",
    "This credit session belongs to its authorized wallet": "CREDIT_SESSION_WALLET_MISMATCH",
    "The selected credit wallet is not linked to this account": "CREDIT_WALLET_NOT_LINKED",
    "Test wallet invitation unavailable": "WALLET_INVITATION_UNAVAILABLE",
    "A linked wallet is required": "WALLET_REQUIRED",
    "Invalid linked wallets": "INVALID_LINKED_WALLETS",
    "Exact Test installation required": "REQUEST_SHAPE_REJECTED",
    "Service is restarting. Try again shortly.": "SERVICE_RESTARTING",
}
JOURNAL_ERRORS = {
    "Journal writer lease required", "Damaged journal recovery anchor",
    "Journal generation missing; reviewed migration required",
    "Journal recovery generation mismatch; possible rollback",
    "Journal generation differs from recovery anchor; possible rollback or interrupted commit",
    "Journal generation exhausted", "Journal generation identity changed",
    "Tracked funding journal missing; restore both journals",
}


def response(raw, expected):
    if b"\r\n\r\n" not in raw:
        return None
    head, body = raw.split(b"\r\n\r\n", 1)
    status = re.match(rb"HTTP/1\.[01] ([0-9]{3}) ", head)
    if not status:
        return {"result": "INVALID_HTTP_RESPONSE"}
    headers = {}
    for line in head.split(b"\r\n")[1:]:
        name, sep, value = line.partition(b":")
        if sep:
            headers[name.lower()] = value.strip().lower()
    if headers.get(b"transfer-encoding") == b"chunked":
        decoded = b""
        while True:
            line, sep, rest = body.partition(b"\r\n")
            if not sep:
                return None
            if not re.fullmatch(rb"[0-9a-fA-F]{1,8}", line):
                return {"result": "INVALID_HTTP_RESPONSE"}
            size = int(line, 16)
            if size > LIMIT or len(decoded) + size > LIMIT:
                return {"result": "OVERSIZED_RESPONSE"}
            if len(rest) < size + 2:
                return None
            if rest[size:size + 2] != b"\r\n":
                return {"result": "INVALID_HTTP_RESPONSE"}
            if not size:
                body = decoded
                break
            decoded += rest[:size]
            body = rest[size + 2:]
    else:
        length = headers.get(b"content-length", b"")
        if not re.fullmatch(rb"[0-9]{1,6}", length):
            return {"result": "UNSUPPORTED_HTTP_RESPONSE"}
        size = int(length)
        if size > LIMIT:
            return {"result": "OVERSIZED_RESPONSE"}
        if len(body) < size:
            return None
        body = body[:size]
    report = {"httpStatus": int(status[1])}
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        return {**report, "result": "INVALID_JSON_RESPONSE"}
    if not isinstance(value, dict):
        return {**report, "result": "INVALID_JSON_RESPONSE"}
    error = value.get("error")
    if isinstance(error, str):
        category = "JOURNAL_RECOVERY_STATE" if error in JOURNAL_ERRORS else ERRORS.get(error, "OTHER_SERVER_REJECTION")
        return {**report, "result": category}
    return {**report, "result": "LEASE_RESPONSE", "granted": value.get("granted") is True,
            "modeMatches": value.get("mode") == expected["mode"],
            "chainMatches": value.get("chainId") == expected["chainId"],
            "walletMatches": value.get("owner") == expected["wallet"],
            "installationFormatValid": bool(re.fullmatch(r"[a-f0-9]{64}", str(value.get("installation", ""))))}


class Observer:
    def __init__(self, expected):
        self.expected = expected
        self.lines = {}
        self.pending = {}
        self.requests = 0

    def feed(self, packet):
        # SOCK_DGRAM on AF_PACKET supplies an IPv4 packet without Ethernet.
        if len(packet) < 40 or packet[0] >> 4 != 4 or packet[9] != 6:
            return None
        ip = (packet[0] & 15) * 4
        if ip < 20 or len(packet) < ip + 20 or packet[12:20] != b"\x7f\x00\x00\x01" * 2:
            return None
        src, dst, seq = struct.unpack_from("!HHI", packet, ip)
        tcp = (packet[ip + 12] >> 4) * 4
        if tcp < 20 or PORT not in (src, dst):
            return None
        body = packet[ip + tcp:struct.unpack_from("!H", packet, 2)[0]]
        if not body:
            return None
        if dst == PORT:
            # Retain at most the request line, never an Authorization header
            # or request body. Other routes do not enable response collection.
            partial = self.lines.pop(src, None)
            line = partial[1] + body if partial and partial[0] == seq else body
            first = line.split(b"\r\n", 1)[0]
            if b"\r\n" in line:
                if first == ROUTE:
                    if len(self.pending) >= 32:
                        return {"result": "TOO_MANY_LEASE_REQUESTS"}
                    self.pending[src] = [None, b""]
                    self.requests += 1
            elif len(first) < len(ROUTE) + 2 and (ROUTE + b"\r\n").startswith(first):
                if len(self.lines) < 32:
                    self.lines[src] = ((seq + len(body)) & 0xffffffff, first)
            return None
        if dst not in self.pending:
            return None
        next_seq, saved = self.pending[dst]
        if next_seq is not None and seq != next_seq:
            # Retransmission duplicates are ignored; gaps cannot become a
            # fabricated result. A fresh retry can be observed instead.
            return None
        if next_seq is None and not body.startswith(b"HTTP/1."):
            return None
        saved += body
        if len(saved) > LIMIT:
            del self.pending[dst]
            return {"result": "OVERSIZED_RESPONSE"}
        self.pending[dst] = [((seq + len(body)) & 0xffffffff), saved]
        result = response(saved, self.expected)
        if result is not None:
            del self.pending[dst]
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wallet", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{25,50}", args.wallet):
        raise ValueError("public wallet required")
    # Verify the fixed loopback service before observing it. No credentials.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{PORT}/health", timeout=5) as health:
        expected = json.loads(health.read(LIMIT + 1))
    if expected.get("product") != "prepaid-usd-v1" or expected.get("mode") != "mainnet-pilot" or not isinstance(expected.get("chainId"), str):
        raise ValueError("unexpected local service")
    expected["wallet"] = args.wallet
    observer = Observer(expected)
    with socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(0x0800)) as capture:
        capture.bind(("lo", 0))
        capture.settimeout(1)
        print("Ready. Retry the purchase in Core now; send the JSON lines printed below.", flush=True)
        deadline, last, count = time.monotonic() + 120, None, 0
        while time.monotonic() < deadline and (last is None or time.monotonic() - last < 15):
            try:
                packet, address = capture.recvfrom(65535)
            except socket.timeout:
                continue
            if address[2] == socket.PACKET_OUTGOING:
                continue
            result = observer.feed(packet)
            if result is not None:
                count += 1
                print(json.dumps({"leaseResponse": count, **result}), flush=True)
                last = time.monotonic()
        print(json.dumps({"finished": True, "leaseRequestsObserved": observer.requests, "leaseResponsesObserved": count}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print('{"stopped":true}')
    except PermissionError:
        print('{"diagnostic":"ROOT_PACKET_ACCESS_REQUIRED"}')
    except Exception:
        print('{"diagnostic":"LOCAL_CHECK_UNAVAILABLE"}')
