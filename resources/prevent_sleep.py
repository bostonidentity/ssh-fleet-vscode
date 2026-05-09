"""Keeps Windows from sleeping while SSH Fleet is engaged."""
import ctypes
import random
import sys
import time

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002
MOUSEEVENTF_MOVE = 0x0001
NUDGE_INTERVAL_SECONDS = 60

prev = ctypes.windll.kernel32.SetThreadExecutionState(
    ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
)
if prev == 0:
    sys.stderr.write("SetThreadExecutionState returned 0 (failed)\n")
    sys.exit(1)

while True:
    dx = random.choice([-1, 1])
    dy = random.choice([-1, 1])
    ctypes.windll.user32.mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, 0)
    time.sleep(NUDGE_INTERVAL_SECONDS)
