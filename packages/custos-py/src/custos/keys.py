"""Ed25519 key management."""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


@dataclass
class KeyPair:
    private: Ed25519PrivateKey
    public: Ed25519PublicKey

    def sign(self, data: bytes) -> bytes:
        return self.private.sign(data)

    def public_bytes(self) -> bytes:
        return self.public.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )

    def private_bytes(self) -> bytes:
        return self.private.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )

    def public_b64(self) -> str:
        return base64.b64encode(self.public_bytes()).decode("ascii")

    def save(self, dir_path: str | Path) -> None:
        d = Path(dir_path)
        d.mkdir(parents=True, exist_ok=True)
        priv = d / "ledger.key"
        pub = d / "ledger.pub"
        priv.write_bytes(base64.b64encode(self.private_bytes()))
        pub.write_bytes(base64.b64encode(self.public_bytes()))
        try:
            os.chmod(priv, 0o600)
        except OSError:
            pass


def generate_keypair() -> KeyPair:
    priv = Ed25519PrivateKey.generate()
    return KeyPair(private=priv, public=priv.public_key())


def load_keypair(dir_path: str | Path) -> KeyPair:
    d = Path(dir_path)
    raw_priv = base64.b64decode((d / "ledger.key").read_bytes())
    priv = Ed25519PrivateKey.from_private_bytes(raw_priv)
    return KeyPair(private=priv, public=priv.public_key())


def load_public_key(path: str | Path) -> Ed25519PublicKey:
    raw = base64.b64decode(Path(path).read_bytes())
    return Ed25519PublicKey.from_public_bytes(raw)


def public_key_from_b64(b64: str) -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(base64.b64decode(b64))
