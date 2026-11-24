# Shared Android runtime: inference failure classification

Reference implementation for Android 0.5.0. This branch extends the existing native-harness reference; it has not been deployed and does not activate catalog native-tool flags.

An upstream HTTP 200 completion with no answer and `finish_reason=length` is a typed failure. If bounded diagnostics report reasoning tokens or reasoning characters, the code is `reasoning_only`; otherwise it is `output_exhausted`. Empty stop completions retain `managed_empty_output`. A nonempty native tool call is not mistaken for an empty answer.

The classifier does not make another upstream POST, increase output limits, bypass wallet policy or mark a failed generation delivered. Existing usage validation, signed settlement and hold release remain authoritative. Only allowlisted scalar diagnostics cross the error boundary; private reasoning text is never returned as answer text or logged by this change.

Android retains findings and records the failure against its own execution run. It may offer explicit bounded continuation or a configured eligible fallback; a gateway inference failure cannot replay an external action whose submission may already have occurred.

Validation: the inference-diagnostics and native-chat probes use synthetic upstream responses and local authenticated HTTP/SSE. They are not live provider qualification. Production rollout still requires route-specific tool/result/follow-up and usage probes plus the installed-base deployment guard. No deployment is part of this change.
