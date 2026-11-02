# RAM Guard

Shows which process trees are using your memory and lets you end them. A background monitor can send a desktop notification when one gets too big. Linux only: it reads `/proc`. The interface follows Treva's layout, with blue and green accents where Treva uses gold.

```sh
# from node/
npm run build:release                    # Nasty native primitives
node examples/ramguard/ramguard.js       # the window
node examples/ramguard/monitor.js --once # one scan in the terminal: list hogs and exit
```

## Entrypoints

- **`ramguard.js`**: the window. It scans as soon as it opens and again every 3 s. You can pause it (P) or scan right away (R). It shows:
  - system memory: in use, cache, available, swap and the threshold
  - a memory map of the 10 largest trees as shares of RAM
  - every process tree with a bar measured against the threshold; expand a tree to see its processes and their command lines
  - the trees over the threshold at the top, under "memory hogs"
- **`monitor.js`**: the background notifier. It never kills anything. Every *interval* it scans; when a tree reaches the threshold it runs `notify-send` once. It notifies about the same tree again after the *cooldown*, or sooner if the tree grows by another 25%. It reads `~/.ramguard/config.json` again whenever the file changes, so new settings apply without a restart.

## Background service

Open the **Monitor** menu and choose **Install and start**. RAM Guard writes two files and enables the service with `systemctl --user enable` and `restart`:

- `~/.config/systemd/user/ramguard-monitor.service`, a systemd **user** service. It runs in your session, so `notify-send` reaches your desktop, and it needs no root. It runs at `Nice=10` with idle I/O priority and is capped at `MemoryMax=256M`.
- `~/.local/share/applications/ramguard.desktop`

**Stop and remove** disables the service, deletes both files and reloads systemd. RAM Guard uses systemd rather than supervisord because systemd is already running in Linux desktop sessions, and supervisord would need its own daemon and config.

Clicking a notification opens RAM Guard:

- Every notification carries the `desktop-entry: ramguard` hint. GNOME Shell (and other servers that honour the hint) opens `ramguard.desktop` when you click the notification. The entry runs `ramguard.js --probe`.
- With libnotify ≥ 0.7.10, `notify-send` also has an **Open RAM Guard** action. The monitor waits for the click and opens the window through `systemd-run --user`, so stopping the service does not close the window.
- If RAM Guard is already open, the new launch sends the open window `SIGUSR1` and exits. The window then scans again and highlights the hogs. On X11 the new launch also tries `xdotool windowactivate` to bring the window to the front.

Settings are kept in `~/.ramguard/config.json`, which the window and the monitor share: threshold, interval, cooldown and "only my processes". Set `RAMGUARD_DATA_DIR` to use another directory.

## Trees and memory

- **Trees.** A tree is an application and every process it started. Each tree starts just below one of these:
  - init or a session manager
  - a desktop shell
  - a terminal shell or multiplexer
  - `sshd`, `sudo` and similar programs
  - a process owned by another user

  So `firefox` (31 processes) is one tree and `make -j32` started from bash is another. Neither gets merged into `systemd` or `bash`.
- **Memory.** Sizes are PSS from `/proc/<pid>/smaps_rollup`, which splits shared pages between the processes that share them, so adding up a tree does not count them twice. Other users' processes can't be read that way; for those RAM Guard shows RSS, marked `≈`. RSS is cheap and never smaller than PSS, so RAM Guard reads RSS for every process first. It reads PSS only for trees whose RSS total could reach the threshold, plus the 24 largest trees in the window.

## Ending processes

**End** asks for a second click within 4 s. RAM Guard then sends `SIGTERM` to every process in the tree (or just the one process, from an expanded row) and checks every 50 ms. Any process still running after **2 s** gets `SIGKILL`. Each process is identified by its pid together with its start time, so a pid that was freed and reused by another process is never signalled. RAM Guard won't end itself, or other users' processes (the button is disabled). Trees whose root is a desktop-session process such as `gnome-shell` or `Xorg` are labelled `session`, and their confirm button reads "End session?".

## What has been checked

These were checked on Ubuntu 22.04 with GNOME 42 on X11 and libnotify 0.7.9:

- The window renders and updates on the desktop. Rows expand, the Monitor menu works and the hog state looks right.
- Ending processes was tested with scripts: a process that exits on `SIGTERM` was gone after 50 ms. A process that ignores `SIGTERM` got `SIGKILL` after 2.0 s, and its child exited on `SIGTERM`.
- The service installed, ran with the session variables and was removed cleanly.
- `notify-send` delivered a notification.
- Launching a second window handed off to the open one.

Not checked:

- Clicking the notification. GNOME should open the window through the desktop-entry hint.
- The libnotify ≥ 0.7.10 action path.
- Wayland: the window comes to the front only on X11, because Nasty has no window-activation API.

## Nasty gaps found while building this

- A flex container's text nodes are only laid out when the container has no element children; if it has both, the text isn't drawn. RAM Guard wraps such labels in `<span>`s.
- `items-baseline` is not supported: the native bridge has no baseline alignment, and Nasty's text measure does not give Taffy any baselines. RAM Guard uses `items-end` there.
