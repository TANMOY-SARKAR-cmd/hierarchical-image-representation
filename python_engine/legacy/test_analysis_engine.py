import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from analysis_engine import analyze, containment_relation


class AnalysisEngineTest(unittest.TestCase):
    def test_generated_geometry_produces_a_complete_deterministic_representation(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = np.zeros((48, 64, 3), dtype=np.uint8)
            source[:, :21] = [225, 55, 60]
            source[:, 21:43] = [40, 190, 135]
            source[:, 43:] = [45, 105, 235]
            Image.fromarray(source).save(workspace / "fixture.png")
            config = {
                "maxFileSizeBytes": 1024 * 1024,
                "maxImagePixels": 786_432,
                "groupingMethod": "slic",
                "scaleLevels": [1, 2, 4, 8],
                "slicSegments": 24,
                "slicCompactness": 8,
                "minimumRegionPixels": 2,
                "hierarchyGroupSize": 3,
            }
            result = analyze(workspace / "fixture.png", workspace / "output", config)
            representation = json.loads(Path(result["representationPath"]).read_text())

            self.assertEqual(representation["version"], "1.0.0")
            self.assertEqual(representation["features"]["shape"], [48, 64, 9])
            self.assertEqual(representation["pixelLevel"]["assignmentKey"], "pixelToMicroregion")
            self.assertEqual(representation["hierarchy"]["levels"]["object_candidate"], 4)
            self.assertGreater(result["entityCount"], 4)
            self.assertGreater(result["relationshipCount"], 0)
            self.assertTrue((workspace / "output" / "features.npz").exists())
            self.assertTrue((workspace / "output" / "reconstructed.png").exists())
            self.assertTrue((workspace / "output" / "reconstruction.svg").exists())
            self.assertTrue(all("memberPixels" in entity for entity in representation["entities"]))
            self.assertTrue(all("containment" in relation for relation in representation["relationships"]))
            self.assertGreaterEqual(representation["metrics"]["ssim"], 0)
            self.assertGreater(representation["metrics"]["processingTimeMs"], 0)

    def test_pixel_ceiling_rejects_an_oversized_source_before_analysis(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            Image.fromarray(np.zeros((32, 32, 3), dtype=np.uint8)).save(workspace / "fixture.png")
            config = {
                "maxFileSizeBytes": 1024 * 1024,
                "maxImagePixels": 512,
                "groupingMethod": "slic",
                "scaleLevels": [1],
                "slicSegments": 12,
                "slicCompactness": 8,
                "minimumRegionPixels": 2,
                "hierarchyGroupSize": 3,
            }
            with self.assertRaisesRegex(ValueError, "pixel analysis ceiling"):
                analyze(workspace / "fixture.png", workspace / "output", config)

    def test_containment_relation_reports_the_correct_direction(self):
        outer = np.zeros((8, 8), dtype=bool)
        outer[1:7, 1:7] = True
        inner = np.zeros((8, 8), dtype=bool)
        inner[3:5, 3:5] = True
        sibling = np.zeros((8, 8), dtype=bool)
        sibling[0:2, 0:2] = True
        self.assertEqual(containment_relation(inner, outer), "source_in_target")
        self.assertEqual(containment_relation(outer, inner), "target_in_source")
        self.assertEqual(containment_relation(inner, sibling), "none")


if __name__ == "__main__":
    unittest.main()
