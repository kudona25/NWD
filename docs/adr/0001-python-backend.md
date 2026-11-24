# Python (FastAPI + Netmiko + ntc-templates) for the discovery backend

The topology crawler SSHes into Cisco switches and parses `show cdp neighbors detail`. We chose Python over Node.js (our usual stack) because ntc-templates ships maintained TextFSM parsers for CDP output across IOS / IOS-XE / NX-OS, and Netmiko handles Cisco prompts, paging and enable mode. In Node we would have to hand-write and maintain CDP parsers per OS. FastAPI gives us WebSocket push for the real-time view.
