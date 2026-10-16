"""PyInstaller entry point for ffcx.exe / ffcx-server.exe."""
import multiprocessing
import sys

if __name__ == '__main__':
    multiprocessing.freeze_support()
    from ffcx.__main__ import main
    sys.exit(main())
