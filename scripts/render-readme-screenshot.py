#!/usr/bin/env python3

from __future__ import annotations

import codecs
import html
import os
import pty
import re
import select
import signal
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "docs" / "assets" / "readme-terminal-screenshot.svg"
PNG_OUTPUT_PATH = REPO_ROOT / "docs" / "assets" / "readme-terminal-screenshot.png"
SCREEN_COLUMNS = 80
SCREEN_ROWS = 24
SERVER_PORT = 2234
SERVER_URL = f"ws://127.0.0.1:{SERVER_PORT}"
EXTERNAL_SERVER_URL = os.environ.get("PIXEL_README_SCREENSHOT_SERVER_URL")
DEFAULT_FG = "#f8fafc"
DEFAULT_BG = "#020617"
CELL_WIDTH = 9
CELL_HEIGHT = 18
FONT_SIZE = 14
FONT_FAMILY = "Menlo, Monaco, Consolas, Liberation Mono, monospace"


@dataclass
class Cell:
    char: str = " "
    fg: str = DEFAULT_FG
    bg: str = DEFAULT_BG


def wait_for_output(stream, pattern: str, timeout: float) -> str:
    deadline = time.time() + timeout
    chunks: list[str] = []
    while time.time() < deadline:
        ready, _, _ = select.select([stream], [], [], 0.2)
        if stream in ready:
            chunk = os.read(stream, 65536).decode("utf-8", errors="ignore")
            chunks.append(chunk)
            if pattern in "".join(chunks):
                return "".join(chunks)
    raise RuntimeError(f"Timed out waiting for {pattern!r}")


def read_available(stream, duration: float) -> str:
    deadline = time.time() + duration
    chunks: list[str] = []
    while time.time() < deadline:
        ready, _, _ = select.select([stream], [], [], 0.05)
        if stream in ready:
            chunks.append(os.read(stream, 65536).decode("utf-8", errors="ignore"))
    return "".join(chunks)


def send_keys(master_fd: int, keys: str, delay: float = 0.18) -> str:
    os.write(master_fd, keys.encode("utf-8"))
    time.sleep(delay)
    return read_available(master_fd, delay)


def start_server() -> subprocess.Popen[str]:
    env = os.environ.copy()
    env["HOST"] = "127.0.0.1"
    env["PORT"] = str(SERVER_PORT)
    process = subprocess.Popen(
        ["bunx", "y-websocket"],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    time.sleep(2)
    if process.poll() is not None:
        output = ""
        if process.stdout is not None:
            try:
                output = process.stdout.read()
            except Exception:
                output = ""
        raise RuntimeError(f"Failed to start local y-websocket server: {output}")
    return process


def spawn_client() -> tuple[subprocess.Popen[bytes], int, str]:
    env = os.environ.copy()
    env.update(
        {
            "TERM": "xterm-256color",
            "COLUMNS": str(SCREEN_COLUMNS),
            "LINES": str(SCREEN_ROWS),
            "PIXEL_SERVER_URL": EXTERNAL_SERVER_URL or SERVER_URL,
            "PIXEL_GITHUB_AUTH_FILE": "/tmp/pxboard-readme-screenshot-auth.json",
            "PIXEL_NAME": "artist",
        }
    )

    master_fd, slave_fd = pty.openpty()
    process = subprocess.Popen(
        ["pnpm", "dev:client"],
        cwd=REPO_ROOT,
        env=env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        preexec_fn=os.setsid,
    )
    os.close(slave_fd)
    initial_output = wait_for_output(master_fd, "Edit access: open", timeout=20)
    initial_output += read_available(master_fd, 0.4)
    return process, master_fd, initial_output


def normalize_color(value: int) -> str:
    return f"#{value:02x}{value:02x}{value:02x}"


def apply_sgr(params: list[int | str], state: dict[str, str]) -> None:
    if not params:
        params = [0]

    index = 0
    while index < len(params):
        code = params[index]
        if isinstance(code, str):
            index += 1
            continue

        if code == 0:
            state["fg"] = DEFAULT_FG
            state["bg"] = DEFAULT_BG
        elif code == 39:
            state["fg"] = DEFAULT_FG
        elif code == 49:
            state["bg"] = DEFAULT_BG
        elif code == 38 and index + 4 < len(params) and params[index + 1] == 2:
            state["fg"] = f"#{int(params[index + 2]):02x}{int(params[index + 3]):02x}{int(params[index + 4]):02x}"
            index += 4
        elif code == 48 and index + 4 < len(params) and params[index + 1] == 2:
            state["bg"] = f"#{int(params[index + 2]):02x}{int(params[index + 3]):02x}{int(params[index + 4]):02x}"
            index += 4
        elif 30 <= code <= 37:
            basic = [
                "#000000",
                "#800000",
                "#008000",
                "#808000",
                "#000080",
                "#800080",
                "#008080",
                "#c0c0c0",
            ]
            state["fg"] = basic[code - 30]
        elif 40 <= code <= 47:
            basic = [
                "#000000",
                "#800000",
                "#008000",
                "#808000",
                "#000080",
                "#800080",
                "#008080",
                "#c0c0c0",
            ]
            state["bg"] = basic[code - 40]
        index += 1


def parse_terminal_frame(raw: str) -> list[list[Cell]]:
    screen = [[Cell() for _ in range(SCREEN_COLUMNS)] for _ in range(SCREEN_ROWS)]
    state = {"fg": DEFAULT_FG, "bg": DEFAULT_BG}
    row = 0
    col = 0
    saved = (0, 0)

    decoder = codecs.getincrementaldecoder("utf-8")()
    text = decoder.decode(raw.encode("utf-8", errors="ignore"), final=True)
    index = 0

    while index < len(text):
        char = text[index]

        if char == "\x1b":
            index += 1
            if index >= len(text):
                break
            marker = text[index]

            if marker == "[":
                index += 1
                start = index
                while index < len(text) and not ("@" <= text[index] <= "~"):
                    index += 1
                if index >= len(text):
                    break
                final = text[index]
                body = text[start:index]
                raw_params = body.lstrip("?=>")
                params: list[int | str] = []
                if raw_params:
                    for part in raw_params.split(";"):
                        if part == "":
                            params.append(0)
                        else:
                            try:
                                params.append(int(part))
                            except ValueError:
                                params.append(part)
                if final == "m":
                    apply_sgr(params, state)
                elif final in {"H", "f"}:
                    target_row = int(params[0]) if len(params) >= 1 and isinstance(params[0], int) and params[0] else 1
                    target_col = int(params[1]) if len(params) >= 2 and isinstance(params[1], int) and params[1] else 1
                    row = max(0, min(SCREEN_ROWS - 1, target_row - 1))
                    col = max(0, min(SCREEN_COLUMNS - 1, target_col - 1))
                elif final == "A":
                    move = int(params[0]) if params and isinstance(params[0], int) else 1
                    row = max(0, row - move)
                elif final == "B":
                    move = int(params[0]) if params and isinstance(params[0], int) else 1
                    row = min(SCREEN_ROWS - 1, row + move)
                elif final == "C":
                    move = int(params[0]) if params and isinstance(params[0], int) else 1
                    col = min(SCREEN_COLUMNS - 1, col + move)
                elif final == "D":
                    move = int(params[0]) if params and isinstance(params[0], int) else 1
                    col = max(0, col - move)
                elif final == "J":
                    if params and params[0] == 2:
                        screen = [[Cell() for _ in range(SCREEN_COLUMNS)] for _ in range(SCREEN_ROWS)]
                        row = 0
                        col = 0
                elif final == "K":
                    for current in range(col, SCREEN_COLUMNS):
                        screen[row][current] = Cell()
                elif final == "s":
                    saved = (row, col)
                elif final == "u":
                    row, col = saved
            elif marker == "]":
                index += 1
                while index < len(text):
                    if text[index] == "\x07":
                        break
                    if text[index] == "\x1b" and index + 1 < len(text) and text[index + 1] == "\\":
                        index += 1
                        break
                    index += 1
            elif marker in {"7", "8"}:
                if marker == "7":
                    saved = (row, col)
                else:
                    row, col = saved
            index += 1
            continue

        if char == "\r":
            col = 0
        elif char == "\n":
            row = min(SCREEN_ROWS - 1, row + 1)
        elif char == "\b":
            col = max(0, col - 1)
        elif char >= " ":
            if 0 <= row < SCREEN_ROWS and 0 <= col < SCREEN_COLUMNS:
                screen[row][col] = Cell(char=char, fg=state["fg"], bg=state["bg"])
            col = min(SCREEN_COLUMNS - 1, col + 1)

        index += 1

    return screen


def render_svg(screen: list[list[Cell]]) -> str:
    width = SCREEN_COLUMNS * CELL_WIDTH
    height = SCREEN_ROWS * CELL_HEIGHT
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Pixel Game terminal screenshot">',
        f'<rect width="{width}" height="{height}" fill="{DEFAULT_BG}" rx="12" ry="12" />',
    ]

    for row_index, row in enumerate(screen):
        for col_index, cell in enumerate(row):
            x = col_index * CELL_WIDTH
            y = row_index * CELL_HEIGHT
            if cell.bg != DEFAULT_BG:
                lines.append(
                    f'<rect x="{x}" y="{y}" width="{CELL_WIDTH}" height="{CELL_HEIGHT}" fill="{cell.bg}" />'
                )
            if cell.char != " ":
                text_x = x + 1
                text_y = y + CELL_HEIGHT - 4
                escaped = html.escape(cell.char)
                lines.append(
                    f'<text x="{text_x}" y="{text_y}" fill="{cell.fg}" '
                    f'font-family="{FONT_FAMILY}" font-size="{FONT_SIZE}px">{escaped}</text>'
                )

    lines.append("</svg>")
    return "\n".join(lines)


def generate_capture() -> str:
    server_process = None
    client_process = None
    master_fd = None
    raw_chunks: list[str] = []

    try:
        if EXTERNAL_SERVER_URL is None:
            server_process = start_server()
        client_process, master_fd, initial_output = spawn_client()
        raw_chunks.append(initial_output)
        raw_chunks.append(read_available(master_fd, 0.3))

        for keys in [" ", "\x1b[C", "2 ", "\x1b[C", "3 ", "\x1b[B", "4 ", "\x1b[D", "5 "]:
            raw_chunks.append(send_keys(master_fd, keys))

        raw_chunks.append(read_available(master_fd, 0.6))
        raw_chunks.append(send_keys(master_fd, "q", delay=0.2))
    finally:
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        if client_process is not None and client_process.poll() is None:
            os.killpg(os.getpgid(client_process.pid), signal.SIGTERM)
            client_process.wait(timeout=5)
        if server_process is not None and server_process.poll() is None:
            server_process.terminate()
            server_process.wait(timeout=5)

    return "".join(raw_chunks)


def main() -> int:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    raw = generate_capture()
    screen = parse_terminal_frame(raw)
    svg = render_svg(screen)
    OUTPUT_PATH.write_text(svg, encoding="utf-8")
    if shutil.which("magick") is not None:
        subprocess.run(["magick", str(OUTPUT_PATH), str(PNG_OUTPUT_PATH)], check=True)
    print(OUTPUT_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
