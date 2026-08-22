import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from engine import analyze


class ParameterSensitivityTest(unittest.TestCase):
    def test_emits_bounded_deterministic_parameter_dependence_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            image = np.zeros((28, 36, 3), dtype=np.uint8)
            image[:, :12] = [30, 160, 220]
            image[:, 12:24] = [220, 80, 55]
            image[:, 24:] = [75, 205, 130]
            source = workspace / "fixture.png"
            Image.fromarray(image).save(source)
            output = workspace / "output"
            progress = []
            payload = json.loads(Path(analyze(source, output, {"maxImagePixels": 10_000, "scaleLevels": [1], "slicSegments": 16, "minimumRegionPixels": 2, "runParameterSensitivity": True, "sensitivityVariantLimit": 2}, progress=lambda stage, percent, message: progress.append((stage, percent, message)))["representationPath"]).read_text())

            report = payload["parameterSensitivity"]
            self.assertEqual(report["schema"], "ParameterSensitivity@0.7")
            self.assertEqual(report["design"], "bounded_one_factor_family_perturbations")
            self.assertEqual(len(report["records"]), 2)
            self.assertIn("not object-level semantic invariance", report["interpretation"])
            self.assertEqual(payload["artifacts"]["parameterSensitivity"], "sensitivity/report.json")
            report_path = output / "sensitivity" / "report.json"
            self.assertTrue(report_path.exists())
            self.assertEqual(json.loads(report_path.read_text())["records"], report["records"])
            self.assertIn("sensitivity/report.json", payload["artifactStorage"]["files"])
            sensitivity_events = [event for event in progress if event[0] == "sensitivity"]
            self.assertGreaterEqual(len(sensitivity_events), 6)
            self.assertEqual(sensitivity_events[-1][1], 93)
            self.assertTrue(any("variant 1 of 2" in event[2] for event in sensitivity_events))
            self.assertTrue(any("variant 2 of 2" in event[2] for event in sensitivity_events))


if __name__ == "__main__":
    unittest.main()
