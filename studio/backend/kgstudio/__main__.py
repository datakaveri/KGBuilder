"""`python -m kgstudio` — start the server."""
import argparse

import uvicorn

from . import config


def main():
    parser = argparse.ArgumentParser(prog="kgstudio", description="KG Studio server")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes (development)")
    args = parser.parse_args()
    uvicorn.run("kgstudio.app:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
