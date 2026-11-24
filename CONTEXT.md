# NWD — Logical Network Topology

Live map of how switches and access points connect, discovered via CDP and LLDP neighbor data read from Cisco switches.

## Language

**Seed Switch**:
The core switch where every crawl starts; the user configures its IP.
_Avoid_: Gateway (the router/firewall may be a different device)

**Site**:
One customer location's network, reached from its own Seed Switch. The map holds one Site at a time; moving to another Site means clearing the map and setting a new Seed Switch. No Crawl runs after startup until the user confirms which Site they are at.
_Avoid_: Project, network

**Crawl**:
One full breadth-first walk from the Seed Switch, following CDP or LLDP neighbors that are switches or access points. Access points are leaves: they appear on the map but are never logged into.
_Avoid_: Scan, discovery run

**Topology Snapshot**:
The set of devices and links found by one Crawl; consecutive snapshots are compared to detect changes.

**Rescan**:
A Crawl triggered manually by the user, outside the periodic schedule.

**Unreachable Device**:
A switch seen as a CDP neighbor but which the Crawl could not log in to; shown on the map but not crawled further.

**Default Credential**:
The single SSH username, password and enable secret used for every switch unless that switch has its own override.

**Device**:
A switch or access point on the map, identified by its CDP Device ID (hostname without domain). The same hostname seen from two neighbors is the same Device.
_Avoid_: Node, host

**Cable**:
One physical connection between a port on one Device and a port on another, as reported by CDP/LLDP.

**Link**:
All Cables between the same pair of Devices, drawn as one line on the map that shows which ports are connected on each side.
_Avoid_: Edge, connection

**Media Type**:
What a Cable physically is: UTP, Fiber Single-mode (SM), Fiber Multi-mode (MM), DAC, or Unknown. Inferred from the port's transceiver type; a user may override it per Cable.

**Change Event**:
A recorded difference between two Topology Snapshots: a Device appeared or disappeared, or a Cable appeared, disappeared or moved port.

**Suspect**:
State of a Device or Cable missing from one Crawl only because its parent switch could not be reached. Becomes gone after a second consecutive miss. If the parent switch was reached and no longer reports it, it is gone immediately.

**Allowed Subnets**:
One or more IP ranges the Crawl may log in to. A switch whose management IP is outside every Allowed Subnet is shown on the map but not crawled. If the list is empty, any switch may be crawled. A maximum hop count from the Seed Switch is a backstop either way.

**Telnet Fallback**:
Optional rule for switches using the Default Credential: if a switch actively refuses SSH, the Crawl logs in with Telnet instead. Not used when SSH times out or the password is wrong. A switch with its own override always uses the protocol set there.
