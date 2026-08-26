from pathlib import Path
import os

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.getenv(
    "CIRCUITLOOP_DATABASE_URL",
    f"sqlite:///{(Path(__file__).resolve().parent / 'circuitloop.db').as_posix()}",
)

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def initialize_database() -> None:
    # Import models before create_all so SQLAlchemy knows every table.
    from backend.models import Component, Scan, TestResult  # noqa: F401

    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    component_columns = {column["name"] for column in inspector.get_columns("components")}
    additions = {
        "scan_id": "INTEGER",
        "x1": "FLOAT",
        "y1": "FLOAT",
        "x2": "FLOAT",
        "y2": "FLOAT",
        "created_at": "DATETIME",
    }
    with engine.begin() as connection:
        for name, sql_type in additions.items():
            if name not in component_columns:
                connection.execute(text(f"ALTER TABLE components ADD COLUMN {name} {sql_type}"))
