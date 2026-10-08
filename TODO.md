# TODO

* list all the parts of maniaclab/af-platform repo that need to be moved over here
* Move things over. Rework actions.
* change executor MCP to use openclaw node at CERN, or remove it completely
* add people to the repo
* write additional instructions for things that others can run.
* replace Qwen 3.6 with Qwen 3.8 on Spark 2 (OWL's cheap model since 2026-10-07: re-run the extraction comparison on the agent memory files after the switch).
* create an additional OpenClaw single-replica StatefulSet in the Analytics cluster. Move an unused agent (e.g. the DDM bot) to it. Test connections, upgrades, vLLM access, etc.
