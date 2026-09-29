#!/usr/bin/env python3
"""Exercise release-image validation and render both local charts without a cluster."""

import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
HELM = os.environ.get("HELM", "helm")
SHA = "0123456789abcdef0123456789abcdef01234567"
APP = "deploy/charts/fuelops"


def helm(*args, expected_error=None):
    result = subprocess.run(
        [HELM, *args], cwd=ROOT, capture_output=True, text=True, check=False
    )
    if expected_error is not None:
        if result.returncode == 0 or expected_error not in result.stderr:
            raise AssertionError(
                f"Expected schema rejection containing {expected_error!r}:\n"
                f"{result.stdout}{result.stderr}"
            )
    elif result.returncode != 0:
        raise RuntimeError(f"helm {' '.join(args)}:\n{result.stdout}{result.stderr}")
    return result.stdout


def main():
    valid_tags = ["--set-string", f"image.tag={SHA},web.tag={SHA}"]
    helm("lint", "deploy/platform")
    helm("template", "platform", "deploy/platform", "--namespace", "kube-system")
    helm("lint", APP, *valid_tags)
    helm("template", "fuelops", APP, "--namespace", "fuelops", *valid_tags)

    # Exercise each image independently so updating only one tag cannot unblock sync.
    for image in ("image", "web"):
        for invalid_tag in ("bootstrap", "latest", "dev", "abcdef0", "", "a" * 39):
            helm(
                "template", "fuelops", APP, *valid_tags,
                "--set-string", f"{image}.tag={invalid_tag}",
                expected_error=f"/{image}/tag",
            )
        helm(
            "template", "fuelops", APP, *valid_tags,
            "--set-string", f"{image}.repository=", expected_error=f"/{image}/repository",
        )

    print("Bootstrap chart checks passed: both charts render; invalid release images are rejected.")


if __name__ == "__main__":
    main()
