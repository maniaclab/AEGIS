# TODO


* Get a new cluster at CERN OpenStack (no EOS, CVMFS)
* Get a k8s Gateway on it
* Deploy all the MCPs at CERN

* change executor MCP to use openclaw node at CERN, or remove it completely
* write additional instructions for things that others can run.
* replace Qwen 3.6 with Qwen 3.8 on Spark 2 (OWL's cheap model since 2026-10-07: re-run the extraction comparison on the agent memory files after the switch).
* create an additional OpenClaw single-replica StatefulSet in the Analytics cluster. Move an unused agent (e.g. the DDM bot) to it. Test connections, upgrades, vLLM access, etc.

* get hindsight UI
* configur HS
