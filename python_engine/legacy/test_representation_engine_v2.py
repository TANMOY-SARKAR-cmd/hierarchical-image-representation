import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from representation_engine_v2 import PIXEL_VECTOR_FIELDS, REGION_VECTOR_FIELDS, analyze


class RelationalRepresentationEngineTest(unittest.TestCase):
    def test_emits_vectorized_sparse_relational_representation_and_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            image = np.zeros((48, 64, 3), dtype=np.uint8)
            image[:, :21] = [225, 55, 60]
            image[:, 21:43] = [40, 190, 135]
            image[:, 43:] = [45, 105, 235]
            image[18:30, 26:38] = [250, 240, 40]
            source = workspace / "fixture.png"
            Image.fromarray(image).save(source)
            output = workspace / "output"
            result = analyze(
                source,
                output,
                {
                    "maxFileSizeBytes": 1024 * 1024,
                    "maxImagePixels": 786_432,
                    "groupingMethod": "slic",
                    "scaleLevels": [1, 2, 4, 8],
                    "slicSegments": 28,
                    "slicCompactness": 8,
                    "minimumRegionPixels": 2,
                    "hierarchyGroupSize": 3,
                    "runScaleConsistency": True,
                    "maxConsistencyPixels": 786_432,
                },
            )
            representation = json.loads(Path(result["representationPath"]).read_text())
            self.assertEqual(representation["representation_version"], "0.2.0")
            self.assertEqual(representation["feature_schema"]["PixelVector"]["fields"], PIXEL_VECTOR_FIELDS)
            self.assertEqual(representation["feature_schema"]["RegionVector"]["fields"], REGION_VECTOR_FIELDS)
            self.assertEqual(representation["features"]["shape"], [48, 64, len(PIXEL_VECTOR_FIELDS)])
            self.assertEqual(representation["hierarchy"]["levels"]["entity"], 4)
            self.assertTrue(all(entity["type"] not in {"part", "object_candidate"} for entity in representation["entities"]))
            self.assertTrue(any(entity["vector"]["provenance"] == "children_recursive_aggregate" for entity in representation["entities"] if entity["type"] != "micro_region"))
            self.assertGreater(len(representation["relationships"]), 0)
            self.assertLess(len(representation["relationships"]), 250)
            first_relationship = representation["relationships"][0]
            for field in ("normalizedDx", "normalizedDy", "brightnessRatio", "colorSimilarity", "shapeSimilarity", "boundaryContactRatio", "confidence", "relationshipType"):
                self.assertIn(field, first_relationship)
            self.assertEqual(representation["scale_consistency"]["status"], "completed")
            self.assertGreater(representation["profiling"]["relationshipConstructionMs"], 0)
            for relative_path in (
                "features.npz", "reconstruction.svg", "reconstructed.png", "reconstructions/level1.png",
                "reconstructions/level4.png", "errors/absolute-error.png", "errors/per-region-error.png",
                "overlays/complexity.png", "overlays/relationship-graph.png",
            ):
                self.assertTrue((output / relative_path).exists(), relative_path)


if __name__ == "__main__":
    unittest.main()
