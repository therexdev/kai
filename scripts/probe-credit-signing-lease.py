#!/usr/bin/env python3
"""Offline parser checks; no live accounts, credentials or payments."""
import importlib.util
import json
import pathlib
import struct
import unittest

spec = importlib.util.spec_from_file_location("diagnostic", pathlib.Path(__file__).with_name("diagnose-credit-signing-lease.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
EXPECTED = {"mode": "mainnet-pilot", "chainId": "synthetic-chain", "wallet": "synthetic-wallet"}
CANARY = "private-value-must-never-be-output"


def packet(src, dst, seq, body):
    ip, tcp = bytearray(20), bytearray(20)
    ip[0], ip[9] = 0x45, 6
    ip[12:20] = b"\x7f\x00\x00\x01" * 2
    struct.pack_into("!H", ip, 2, 40 + len(body))
    struct.pack_into("!HHI", tcp, 0, src, dst, seq)
    tcp[12] = 0x50
    return bytes(ip + tcp) + body


def reply(value, status=400, chunked=True):
    raw = json.dumps(value).encode()
    framing = b"Transfer-Encoding: chunked" if chunked else b"Content-Length: " + str(len(raw)).encode()
    body = hex(len(raw))[2:].encode() + b"\r\n" + raw + b"\r\n0\r\n\r\n" if chunked else raw
    return b"HTTP/1.1 " + str(status).encode() + b" Result\r\nSet-Cookie: " + CANARY.encode() + b"\r\n" + framing + b"\r\n\r\n" + body


class Tests(unittest.TestCase):
    def request(self, observer, port=40000):
        value = module.ROUTE + b"\r\nAuthorization: Bearer " + CANARY.encode() + b"\r\n\r\n{\"installation\":\"" + CANARY.encode() + b"\"}"
        observer.feed(packet(port, module.PORT, 100, value))

    def test_categories_and_no_private_output(self):
        for message, category in module.ERRORS.items():
            observer = module.Observer(EXPECTED)
            self.request(observer)
            result = observer.feed(packet(module.PORT, 40000, 200, reply({"error": message, "private": CANARY})))
            self.assertEqual(result, {"httpStatus": 400, "result": category})
            self.assertNotIn(CANARY, json.dumps(result))
            self.assertEqual(observer.pending, {})
            self.assertEqual(observer.lines, {})

    def test_authentication_status(self):
        self.assertEqual(module.response(reply({"error": "Test invitation required"}, 401), EXPECTED),
                         {"httpStatus": 401, "result": "ACCOUNT_AUTH_REQUIRED"})

    def test_recovery_rejections_are_classified_without_message(self):
        for message in module.JOURNAL_ERRORS:
            self.assertEqual(module.response(reply({"error": message}), EXPECTED)["result"], "JOURNAL_RECOVERY_STATE")

    def test_unknown_error_does_not_disclose_raw_text(self):
        self.assertEqual(module.response(reply({"error": CANARY}), EXPECTED),
                         {"httpStatus": 400, "result": "OTHER_SERVER_REJECTION"})

    def test_other_routes_cannot_enable_response_collection(self):
        observer = module.Observer(EXPECTED)
        observer.feed(packet(40000, module.PORT, 100, b"POST /auth/session HTTP/1.1\r\nAuthorization: " + CANARY.encode()))
        self.assertIsNone(observer.feed(packet(module.PORT, 40000, 200, reply({"error": "Test invitation required"}))))
        self.assertEqual(observer.requests, 0)

    def test_split_request_and_segmented_chunked_response(self):
        observer = module.Observer(EXPECTED)
        request = module.ROUTE + b"\r\nAuthorization: " + CANARY.encode() + b"\r\n\r\n"
        observer.feed(packet(40000, module.PORT, 100, request[:10]))
        observer.feed(packet(40000, module.PORT, 110, request[10:]))
        raw = reply({"error": "Exact Test installation required"})
        result = None
        for offset in range(0, len(raw), 11):
            segment = packet(module.PORT, 40000, 200 + offset, raw[offset:offset + 11])
            result = observer.feed(segment)
            self.assertIsNone(observer.feed(segment), "duplicate segments must not be appended")
        self.assertEqual(result, {"httpStatus": 400, "result": "REQUEST_SHAPE_REJECTED"})

    def test_grant_fields_are_reported_only_as_comparisons(self):
        value = {**EXPECTED, "owner": EXPECTED["wallet"], "installation": "a" * 64, "granted": True}
        result = module.response(reply(value, 200, False), EXPECTED)
        self.assertEqual(result, {"httpStatus": 200, "result": "LEASE_RESPONSE", "granted": True,
                                 "modeMatches": True, "chainMatches": True, "walletMatches": True, "installationFormatValid": True})
        value["chainId"] = "other"
        self.assertFalse(module.response(reply(value, 200), EXPECTED)["chainMatches"])
        self.assertNotIn(EXPECTED["wallet"], json.dumps(result))
        self.assertNotIn("a" * 64, json.dumps(result))

    def test_incomplete_and_oversized_responses(self):
        self.assertIsNone(module.response(b"HTTP/1.1 400 Result\r\n", EXPECTED))
        self.assertEqual(module.response(b"HTTP/1.1 400 Result\r\nTransfer-Encoding: chunked\r\n\r\nFFFFFF\r\n", EXPECTED),
                         {"result": "OVERSIZED_RESPONSE"})
        observer = module.Observer(EXPECTED)
        self.request(observer)
        self.assertEqual(observer.feed(packet(module.PORT, 40000, 200, b"HTTP/1.1 " + b"x" * module.LIMIT)),
                         {"result": "OVERSIZED_RESPONSE"})


if __name__ == "__main__":
    unittest.main()
