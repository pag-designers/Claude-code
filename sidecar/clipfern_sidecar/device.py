"""Hardware detection and CUDA library preloading."""

from __future__ import annotations

import ctypes
import glob
import os
import platform
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class DeviceInfo:
    #: Hardware accelerator that is present: "cuda" | "mps" | "cpu".
    device: str
    #: Device faster-whisper actually runs on ("cuda" | "cpu"). CTranslate2 has no Metal backend.
    whisper_device: str
    compute_type: str
    cuda_devices: int
    note: str | None


def _site_nvidia_dirs() -> list[str]:
    dirs: list[str] = []
    for base in sys.path:
        for sub in ("cublas", "cudnn", "cuda_nvrtc"):
            dirs.extend(glob.glob(os.path.join(base, "nvidia", sub, "lib" if os.name != "nt" else "bin")))
    return dirs


def preload_cuda_libraries() -> None:
    """Make the pip-installed cuBLAS/cuDNN (requirements-cuda.txt) visible to CTranslate2."""
    dirs = _site_nvidia_dirs()
    if not dirs:
        return
    if os.name == "nt":
        for d in dirs:
            os.add_dll_directory(d)
        os.environ["PATH"] = os.pathsep.join([*dirs, os.environ.get("PATH", "")])
        return
    # Linux: the dynamic loader reads LD_LIBRARY_PATH only at process start, so dlopen the
    # libraries globally instead; CTranslate2 then resolves its NEEDED entries against them.
    for d in dirs:
        for lib in sorted(glob.glob(os.path.join(d, "lib*.so*"))):
            try:
                ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass


def detect(preference: str | None = None) -> DeviceInfo:
    """`preference` is the user's setting: auto | gpu | cpu (env CLIPFERN_DEVICE)."""
    preference = (preference or os.environ.get("CLIPFERN_DEVICE") or "auto").lower()
    cuda_devices = 0
    note: str | None = None
    if preference != "cpu":
        preload_cuda_libraries()
        try:
            import ctranslate2

            cuda_devices = int(ctranslate2.get_cuda_device_count())
        except Exception as exc:  # noqa: BLE001 - driver problems must not crash the sidecar
            note = f"CUDA probe failed: {exc}"
    is_mac_arm = sys.platform == "darwin" and platform.machine() == "arm64"
    if cuda_devices > 0:
        return DeviceInfo("cuda", "cuda", "float16", cuda_devices, note)
    if preference == "gpu" and note is None:
        note = "GPU requested but no CUDA device was found; using CPU (int8)."
    if is_mac_arm:
        mac_note = "Apple Silicon detected; faster-whisper runs on the CPU (int8)."
        return DeviceInfo("mps", "cpu", "int8", 0, note or mac_note)
    return DeviceInfo("cpu", "cpu", "int8", 0, note)


def machine_summary() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "platform": f"{sys.platform}-{platform.machine()}",
    }
