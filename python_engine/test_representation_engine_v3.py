import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from engine import analyze
from graph import relationship_for
from geometry import make_entity
from schema import SCHEMA_VERSION, read_compatible_representation


class GraphDrivenRelationalEntityEngineTest(unittest.TestCase):
    def test_emits_versioned_graph_driven_entities_without_duplicate_pixel_lists(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            image = np.zeros((56, 72, 3), dtype=np.uint8)
            image[:, :24] = [225, 60, 70]
            image[:, 24:48] = [45, 185, 135]
            image[:, 48:] = [55, 105, 230]
            image[18:38, 28:44] = [245, 235, 55]
            source = workspace / "fixture.png"; Image.fromarray(image).save(source)
            output = workspace / "output"
            result = analyze(source, output, {"maxImagePixels": 100_000, "scaleLevels": [1, 2], "slicSegments": 32, "slicCompactness": 8, "minimumRegionPixels": 2, "runScaleConsistency": True})
            representation = json.loads(Path(result["representationPath"]).read_text())

            self.assertEqual(representation["representation_version"], SCHEMA_VERSION)
            self.assertEqual(representation["experiment"]["engineVersion"], SCHEMA_VERSION)
            self.assertIn("configHash", representation["experiment"])
            fields = representation["feature_schema"]["PixelVector"]["fields"]
            self.assertIn("appearance.lab_l", fields); self.assertIn("local_structure.gradient_orientation", fields)
            self.assertEqual(representation["hierarchy"]["grouping"], "connectivity-constrained graph agglomeration")
            self.assertTrue(representation["validity"]["valid"])
            self.assertAlmostEqual(representation["validity"]["leafCoverage"], 1.0)
            self.assertFalse(representation["validity"]["duplicatePixelStorage"])
            self.assertTrue(all("memberPixels" not in entity for entity in representation["entities"]))
            entities_by_id = {entity["id"]: entity for entity in representation["entities"]}
            root = entities_by_id[representation["hierarchy"]["rootId"]]
            self.assertIsNone(root["parentId"])
            for entity in representation["entities"]:
                if entity["children"]:
                    self.assertEqual(entity["geometry"]["area"], sum(entities_by_id[child]["geometry"]["area"] for child in entity["children"]))
                    self.assertTrue(all(entities_by_id[child]["level"] < entity["level"] for child in entity["children"]))
                visited = {entity["id"]}; current = entity
                while current["parentId"]:
                    self.assertNotIn(current["parentId"], visited)
                    visited.add(current["parentId"]); current = entities_by_id[current["parentId"]]
            for entity in representation["entities"]:
                structured = entity["vector"]["structured"]["geometry"]
                self.assertEqual(structured["area"], entity["geometry"]["area"])
                self.assertEqual(structured["perimeter"], entity["geometry"]["perimeter"])
            same_level = [item for item in representation["relationships"] if item.get("candidateSources") and "hierarchy" not in item["candidateSources"]]
            self.assertGreater(len(same_level), 0)
            self.assertTrue(all("candidateSources" in item and "mergeAffinity" in item and "logAreaRatio" in item for item in same_level))
            self.assertTrue(any(item.get("primaryType") == "contains" for item in representation["relationships"]))
            self.assertEqual(representation["scale_correspondence"]["method"].split(" ")[0], "Hungarian")
            self.assertGreater(len(representation["scale_correspondence"]["links"]), 0)
            self.assertTrue(all(0 <= link["confidence"] <= 1 and link["cost"] <= 0.72 for link in representation["scale_correspondence"]["links"]))
            self.assertEqual(read_compatible_representation(representation)["compatibility"], "native-v0.3")
            for relative_path in ("features.npz", "representation.json", "reconstructed.png", "reconstruction.svg", "overlays/relationship-graph.png", "reconstructions/level4.png"):
                self.assertTrue((output / relative_path).exists(), relative_path)

    def test_directional_relationship_fields_are_antisymmetric_while_distance_is_symmetric(self):
        image = np.zeros((8, 12, 3), dtype=np.uint8)
        image[:, :6] = [80, 140, 220]; image[:, 6:] = [220, 110, 70]
        from features import extract_features
        from schema import resolved_config

        config = resolved_config({"minimumRegionPixels": 1})
        _, fields = extract_features(image, config)
        first_mask = np.zeros((8, 12), dtype=bool); first_mask[:, :6] = True
        second_mask = ~first_mask
        first = make_entity("first", "micro_region", 1, 1, first_mask, image, fields)
        second = make_entity("second", "micro_region", 1, 1, second_mask, image, fields)
        forward = relationship_for(first, second, first_mask, second_mask, image.shape[:2], ["adjacent"], 8, config)
        reverse = relationship_for(second, first, second_mask, first_mask, image.shape[:2], ["adjacent"], 8, config)
        self.assertAlmostEqual(forward["distance"], reverse["distance"])
        self.assertAlmostEqual(forward["normalizedDistance"], reverse["normalizedDistance"])
        self.assertAlmostEqual(forward["normalizedDx"], -reverse["normalizedDx"])
        self.assertAlmostEqual(forward["normalizedDy"], -reverse["normalizedDy"])
        self.assertAlmostEqual(forward["logAreaRatio"], -reverse["logAreaRatio"])

    def test_compatibility_reader_accepts_v02_without_mutating_its_history(self):
        payload = {"representation_version": "0.2.0", "entities": [], "relationships": [], "hierarchy": {}}
        self.assertEqual(read_compatible_representation(payload)["compatibility"], "legacy-v0.2")


if __name__ == "__main__":
    unittest.main()
