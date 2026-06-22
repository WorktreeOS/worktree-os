---
title: WSL access
description: Reach the WorktreeOS web UI from the Windows host (or beyond) when the daemon runs inside WSL.
---

The daemon web UI listens on `127.0.0.1:4949` inside WSL by default. To reach it
from outside the Windows host, run the Windows networking setup from an
**elevated** Windows Command Prompt or PowerShell.

## 1. Allow the port through the firewall

Either disable the Windows firewall:

```cmd
netsh advfirewall set allprofiles state off
```

or keep the firewall enabled and allow inbound TCP on the WorktreeOS web port:

```cmd
netsh advfirewall firewall add rule ^
  name="WSL 4949" ^
  dir=in ^
  action=allow ^
  protocol=TCP ^
  localport=4949
```

## 2. Forward the host port to the WSL instance

```cmd
netsh interface portproxy add v4tov4 ^
  listenaddress=0.0.0.0 ^
  listenport=4949 ^
  connectaddress=<IP_WSL> ^
  connectport=4949
```

Replace `<IP_WSL>` with the current WSL IP address.

## Keep the rule current

WSL can assign a new IP after a restart, so update the `portproxy` rule if
external access stops working.

:::note
If you changed `web.port` in `<wos-home>/config.json`, substitute your port for
`4949` in both commands.
:::
