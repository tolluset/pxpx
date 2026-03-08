#!/usr/bin/env python3

import argparse
import errno
import fcntl
import os
import select
import signal
import socket
import struct
import sys
import termios
import time


def parse_args():
    parser = argparse.ArgumentParser(description="Bridge stdin/stdout to a PTY child process.")
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--gid", type=int, required=True)
    parser.add_argument("--control-socket", default="")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    if args.command and args.command[0] == "--":
        args.command = args.command[1:]

    if not args.command:
        parser.error("missing command after --")

    return args


def set_window_size(fd, rows, cols):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def connect_control_socket(socket_path):
    if not socket_path:
        return None

    deadline = time.time() + 5.0
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

    while True:
        try:
            client.connect(socket_path)
            client.setblocking(False)
            return client
        except FileNotFoundError:
            pass
        except ConnectionRefusedError:
            pass

        if time.time() >= deadline:
            client.close()
            return None

        time.sleep(0.05)


def decode_exit_status(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)

    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)

    return 1


def main():
    args = parse_args()
    control_socket = connect_control_socket(args.control_socket)
    child_pid = None

    def terminate_child(*_unused):
        nonlocal child_pid
        if child_pid is None:
            sys.exit(1)

        try:
            os.kill(child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, terminate_child)
    signal.signal(signal.SIGINT, terminate_child)

    child_pid, master_fd = os.forkpty()

    if child_pid == 0:
        os.setgid(args.gid)
        os.setuid(args.uid)
        os.chdir(args.cwd)
        os.execvp(args.command[0], args.command)
        raise SystemExit(1)

    set_window_size(master_fd, args.rows, args.cols)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    control_buffer = b""
    stdin_open = True
    exit_code = 1
    child_reaped = False

    try:
        while True:
            read_fds = [master_fd]

            if stdin_open:
                read_fds.append(stdin_fd)

            if control_socket is not None:
                read_fds.append(control_socket)

            ready, _, _ = select.select(read_fds, [], [], 0.25)

            if master_fd in ready:
                try:
                    payload = os.read(master_fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        payload = b""
                    else:
                        raise

                if not payload:
                    _, status = os.waitpid(child_pid, 0)
                    exit_code = decode_exit_status(status)
                    child_reaped = True
                    break

                os.write(stdout_fd, payload)

            if stdin_open and stdin_fd in ready:
                payload = os.read(stdin_fd, 65536)

                if payload:
                    os.write(master_fd, payload)
                else:
                    stdin_open = False
                    try:
                        os.kill(child_pid, signal.SIGHUP)
                    except ProcessLookupError:
                        pass

            if control_socket is not None and control_socket in ready:
                payload = control_socket.recv(4096)

                if not payload:
                    control_socket.close()
                    control_socket = None
                else:
                    control_buffer += payload

                    while b"\n" in control_buffer:
                        raw_line, control_buffer = control_buffer.split(b"\n", 1)
                        line = raw_line.decode("utf8", errors="ignore").strip()

                        if not line:
                            continue

                        parts = line.split()

                        if len(parts) != 2:
                            continue

                        try:
                            rows = int(parts[0])
                            cols = int(parts[1])
                        except ValueError:
                            continue

                        set_window_size(master_fd, rows, cols)

                        try:
                            os.kill(child_pid, signal.SIGWINCH)
                        except ProcessLookupError:
                            pass
                        except PermissionError:
                            # The PTY size has already been updated via TIOCSWINSZ.
                            # Hosted deployments may run without CAP_KILL, so best-effort
                            # SIGWINCH delivery must not crash the runner.
                            pass

            waited_pid, status = os.waitpid(child_pid, os.WNOHANG)

            if waited_pid == child_pid:
                exit_code = decode_exit_status(status)
                child_reaped = True
                break
    finally:
        if control_socket is not None:
            control_socket.close()

        try:
            os.close(master_fd)
        except OSError:
            pass

        if not child_reaped:
            try:
                _, status = os.waitpid(child_pid, 0)
                exit_code = decode_exit_status(status)
            except ChildProcessError:
                pass

    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
