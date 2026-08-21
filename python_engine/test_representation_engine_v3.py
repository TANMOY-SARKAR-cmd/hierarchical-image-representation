import json
import tempfile
import unittest
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from engine import analyze
from graph import relationship_for
from geometry import make_entity
from hierarchy import build_global_merge_tree, graph_group_level
from reconstruction_models import fit_appearance_model
from schema import SCHEMA_VERSION, read_compatible_representation
from segmentation import segment_image


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
            self.assertEqual(representation["hierarchy"]["grouping"], "global_energy_scored_4_neighbour_merge_tree_with_derived_cuts")
            self.assertIn("treeNodeIds", representation["hierarchy"])
            self.assertEqual(set(representation["hierarchy"]["cuts"]), {"region", "composite", "entity"})
            self.assertEqual(representation["hierarchy"]["rootSemantics"], "explicit_full_image_anchor_not_inferred_agglomeration")
            self.assertTrue(representation["experiment"]["researchPrototype"])
            self.assertTrue(representation["validity"]["valid"])
            self.assertAlmostEqual(representation["validity"]["leafCoverage"], 1.0)
            self.assertFalse(representation["validity"]["duplicatePixelStorage"])
            self.assertTrue(all("memberPixels" not in entity for entity in representation["entities"]))
            micro_models = [entity["appearanceModel"] for entity in representation["entities"] if entity["type"] == "micro_region"]
            self.assertTrue(micro_models)
            self.assertTrue(all(model["schema"] == "AppearanceModel@0.7" and model["coordinateSystem"] == "entity_local_bounding_box_normalized_minus1_to1" for model in micro_models))
            self.assertTrue(all(model["selectionObjective"] == "normalized_cielab_squared_error_plus_model_and_boundary_penalties" for model in micro_models))
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
            self.assertGreater(len(representation["scale_correspondence"]["overlapLinks"]), 0)
            self.assertTrue(all(link["primaryType"] == "cross_scale_overlap" and link["semantics"] == "fine_to_coarse_overlap_not_hierarchy_containment" for link in representation["scale_correspondence"]["overlapLinks"]))
            overlap_matrix = representation["scale_correspondence"]["normalizedOverlapMatrix"]
            self.assertEqual(overlap_matrix["schema"], "NormalizedFineToCoarseOverlapMatrix@0.7")
            self.assertTrue(overlap_matrix["matrices"])
            self.assertTrue(all(0.0 <= row["coverageSum"] <= 1.0 for matrix in overlap_matrix["matrices"] for row in matrix["rows"]))
            self.assertTrue(all(0 <= link["confidence"] <= 1 and link["cost"] <= 0.72 for link in representation["scale_correspondence"]["links"]))
            self.assertTrue(all("crossScaleParentId" not in entity for entity in representation["entities"]))
            self.assertTrue(any(entity.get("crossScaleMatchId") for entity in representation["entities"]))
            self.assertEqual(read_compatible_representation(representation)["compatibility"], "native-v0.7")
            self.assertIn("slic", representation["segmentationDiagnostics"])
            self.assertIn("residual", representation["reconstruction_metadata"]["outputs"])
            self.assertIn("parametric", representation["reconstruction_metadata"]["heuristicRateDistortion"]["modes"])
            self.assertEqual(representation["reconstruction_metadata"]["heuristicRateDistortion"]["basis"], "parameter_payload_estimate_not_serialized_storage")
            self.assertEqual(representation["artifactStorage"]["basis"], "actual_emitted_file_bytes")
            self.assertEqual(representation["artifactStorage"]["files"]["features.npz"], (output / "features.npz").stat().st_size)
            self.assertEqual(representation["artifactStorage"]["files"]["residuals.npz"], (output / "residuals.npz").stat().st_size)
            residual = representation["reconstruction_metadata"]["residual"]
            self.assertTrue(residual["artifactEmitted"])
            self.assertEqual(residual["actualEncodedBytes"], (output / "residuals.npz").stat().st_size)
            self.assertLessEqual(residual["actualEncodedBytes"], representation["configuration"]["residualBudgetBytes"])
            with np.load(output / "residuals.npz") as sparse:
                self.assertEqual(set(sparse.files), {"indices", "values", "shape", "quantizationStep"})
            self.assertTrue(all(entity.get("appearanceModel", {}).get("model") in {"constant", "affine", "quadratic"} for entity in representation["entities"] if entity["type"] == "micro_region"))
            self.assertTrue(all("boundaryResidual" in entity.get("appearanceModel", {}) for entity in representation["entities"] if entity["type"] == "micro_region"))
            for relative_path in ("features.npz", "residuals.npz", "representation.json", "reconstructed.png", "reconstruction.svg", "overlays/relationship-graph.png", "reconstructions/level4.png", "reconstructions/parametric.png", "reconstructions/residual.png", "errors/residual-energy.png"):
                self.assertTrue((output / relative_path).exists(), relative_path)

    def test_alternative_segmentation_strategies_are_deterministic_and_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory); image = np.zeros((36, 48, 3), dtype=np.uint8)
            image[:, :16] = [35, 110, 220]; image[:, 16:32] = [225, 135, 65]; image[:, 32:] = [65, 190, 125]
            source = workspace / "fixture.png"; Image.fromarray(image).save(source)
            for strategy in ("watershed", "felzenszwalb"):
                output = workspace / strategy
                payload = json.loads(Path(analyze(source, output, {"maxImagePixels": 10_000, "scaleLevels": [1], "slicSegments": 18, "minimumRegionPixels": 2, "segmentationStrategy": strategy, "compareSegmentationBaselines": True})["representationPath"]).read_text())
                self.assertEqual(payload["configuration"]["segmentationStrategy"], strategy)
                self.assertEqual(set(payload["segmentationDiagnostics"]), {"slic", "watershed", "felzenszwalb"})
                self.assertGreater(payload["segmentationDiagnostics"][strategy]["entityCount"], 0)

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

    def test_v04_compatibility_maps_historical_cross_scale_parent_to_match_alias(self):
        payload = {"representation_version": "0.4.0", "entities": [{"id": "native", "crossScaleParentId": "coarse"}], "relationships": [], "hierarchy": {}}
        compatible = read_compatible_representation(payload)
        self.assertEqual(compatible["compatibility"], "native-v0.4-with-correspondence-alias")
        self.assertEqual(compatible["entities"][0]["crossScaleMatchId"], "coarse")
        self.assertEqual(payload["entities"][0].get("crossScaleMatchId"), None)

    def test_boundary_residual_is_candidate_specific_and_can_influence_model_score(self):
        from schema import resolved_config

        image = np.zeros((12, 12, 3), dtype=np.uint8)
        for x in range(2, 10):
            image[2:10, x] = [20 + x * 18, 80 + x * 8, 180 - x * 10]
        mask = np.zeros((12, 12), dtype=bool); mask[2:10, 2:10] = True
        fields = {"edge_strength": np.ones((12, 12), dtype=np.float64)}
        model = fit_appearance_model(mask, image, fields, resolved_config({"appearanceModelCandidates": ["constant", "affine"], "modelPenalty": 0.0, "boundaryLeakagePenalty": 1.0}))
        candidates = {item["model"]: item for item in model["candidates"]}
        self.assertNotEqual(candidates["constant"]["boundaryResidual"], candidates["affine"]["boundaryResidual"])
        self.assertEqual(model["boundaryResidual"], candidates[model["model"]]["boundaryResidual"])

    def test_cross_scale_matching_honors_disable_and_pixel_ceiling(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory); image = np.zeros((32, 48, 3), dtype=np.uint8); image[:, :24] = [40, 120, 220]; image[:, 24:] = [220, 120, 40]
            source = workspace / "fixture.png"; Image.fromarray(image).save(source)
            disabled = json.loads(Path(analyze(source, workspace / "disabled", {"maxImagePixels": 10_000, "scaleLevels": [1, 2], "slicSegments": 16, "minimumRegionPixels": 2, "runScaleConsistency": False})["representationPath"]).read_text())
            limited = json.loads(Path(analyze(source, workspace / "limited", {"maxImagePixels": 10_000, "scaleLevels": [1, 2], "slicSegments": 16, "minimumRegionPixels": 2, "runScaleConsistency": True, "maxConsistencyPixels": 64})["representationPath"]).read_text())
            for payload, status in ((disabled, "disabled"), (limited, "skipped_pixel_limit")):
                self.assertEqual(payload["scale_consistency"]["status"], status)
                self.assertEqual(payload["scale_correspondence"]["links"], [])
                self.assertTrue(all(not item["crossScaleLinks"] for item in payload["scales"]))
                self.assertEqual(payload["profiling"]["crossScaleCorrespondenceMs"], 0.0)

    def test_edge_barrier_blocks_strong_boundary_merges_and_invalid_segmentation_fails(self):
        from features import extract_features
        from schema import resolved_config

        image = np.full((12, 16, 3), 120, dtype=np.uint8)
        base_config = resolved_config({"minimumRegionPixels": 1, "mergeEnergyThreshold": 1.0, "maxEntityAreaFraction": 1.0, "edgeBarrierThreshold": 0.25})
        _, fields = extract_features(image, base_config); fields["edge_strength"][:] = 1.0
        first_mask = np.zeros((12, 16), dtype=bool); first_mask[:, :8] = True; second_mask = ~first_mask
        children = [make_entity("first", "micro_region", 1, 1, first_mask, image, fields), make_entity("second", "micro_region", 1, 1, second_mask, image, fields)]
        masks = {"first": first_mask, "second": second_mask}
        blocked = graph_group_level(children, masks, image, fields, "region", 2, base_config, 1.0)
        self.assertEqual(len(blocked), 2)
        self.assertTrue(all(item["lineage"]["operation"] != "energy_merge" for item in blocked))
        permitted = graph_group_level(children, masks, image, fields, "region", 2, {**base_config, "edgeBarrierThreshold": 1.0}, 1.0)
        self.assertEqual(len(permitted), 1)
        self.assertEqual(permitted[0]["lineage"]["mergeEvidence"]["energy"]["deltaBoundary"], 1.0)
        self.assertEqual(permitted[0]["lineage"]["mergeEvidence"]["edgeBarrierThreshold"], 1.0)
        with self.assertRaisesRegex(ValueError, "Unsupported segmentation strategy"):
            segment_image(image, "felzenzwalb", 16, 10, 1)

    def test_iterative_agglomeration_can_extend_a_chain_within_one_level(self):
        from features import extract_features
        from schema import resolved_config

        image = np.full((12, 18, 3), 120, dtype=np.uint8)
        config = resolved_config({"minimumRegionPixels": 1, "mergeEnergyThreshold": 1.0, "maxEntityAreaFraction": 1.0, "edgeBarrierThreshold": 1.0, "maxAgglomerationIterations": 10})
        _, fields = extract_features(image, config); fields["edge_strength"][:] = 0.0
        masks = {}
        children = []
        for index, start in enumerate((0, 6, 12)):
            mask = np.zeros((12, 18), dtype=bool); mask[:, start:start + 6] = True
            entity_id = f"part-{index}"
            masks[entity_id] = mask
            children.append(make_entity(entity_id, "micro_region", 1, 1, mask, image, fields))
        nodes, roots, evidence = build_global_merge_tree(children, masks, image, fields, config)
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["treeLeafCount"], 3)
        self.assertEqual(len(nodes), 2)
        self.assertEqual(sum(item.get("accepted", False) for item in evidence), 2)

    def test_tiny_residual_budget_omits_an_unrepresentable_sparse_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            image = np.zeros((24, 24, 3), dtype=np.uint8); image[:, :12] = [20, 160, 230]; image[:, 12:] = [220, 80, 50]
            source = workspace / "fixture.png"; Image.fromarray(image).save(source)
            output = workspace / "tiny-budget"
            payload = json.loads(Path(analyze(source, output, {"maxImagePixels": 10_000, "scaleLevels": [1], "slicSegments": 16, "minimumRegionPixels": 2, "residualBudgetBytes": 1})["representationPath"]).read_text())
            residual = payload["reconstruction_metadata"]["residual"]
            self.assertEqual(residual["schema"], "QuantizedSparseResidual@0.7")
            self.assertEqual(residual["selection"], "largest_rgb_squared_error_reduction_quantized_residual")
            self.assertEqual(residual["selectionObjective"], "measured_rgb_squared_error_reduction_after_quantization")
            self.assertFalse(residual["artifactEmitted"])
            self.assertTrue(residual["noPayloadFitsBudget"])
            self.assertEqual(residual["actualEncodedBytes"], 0)
            self.assertIsNone(payload["artifacts"]["residuals"])
            self.assertFalse((output / "residuals.npz").exists())

    def test_explicit_cielab_units_four_neighbour_topology_and_child_statistics_aggregation(self):
        from features import extract_features
        from geometry import aggregate_sufficient_statistics
        from graph import masks_touch
        from schema import resolved_config

        image = np.zeros((4, 6, 3), dtype=np.uint8)
        image[:, :3] = [255, 0, 0]
        image[:, 3:] = [0, 255, 0]
        _, fields = extract_features(image, resolved_config({"minimumRegionPixels": 1}))
        self.assertGreater(fields["lab_l"].max(), 50.0)
        self.assertLessEqual(fields["lab_l"].max(), 100.0)
        self.assertGreater(abs(float(fields["lab_a"][:, :3].mean() - fields["lab_a"][:, 3:].mean())), 50.0)
        first = np.zeros((4, 6), dtype=bool); first[:, :3] = True
        second = ~first
        diagonal = np.zeros((4, 6), dtype=bool); diagonal[0, 4] = True
        isolated = np.zeros((4, 6), dtype=bool); isolated[1, 5] = True
        self.assertTrue(masks_touch(first, second))
        self.assertFalse(masks_touch(diagonal, isolated))
        first_entity = make_entity("left", "micro_region", 1, 1, first, image, fields)
        second_entity = make_entity("right", "micro_region", 1, 1, second, image, fields)
        aggregate = aggregate_sufficient_statistics([first_entity, second_entity])
        union_entity = make_entity("union", "region", 2, 1, first | second, image, fields, ["left", "right"], sufficient_override=aggregate)
        self.assertEqual(aggregate["count"], union_entity["geometry"]["area"])
        self.assertAlmostEqual(aggregate["sum"]["lab_l"], first_entity["statistics"]["sufficient"]["sum"]["lab_l"] + second_entity["statistics"]["sufficient"]["sum"]["lab_l"], places=8)
        self.assertEqual(union_entity["vector"]["aggregation"], "child_sufficient_statistics_and_canonical_mask_geometry")

    def test_reports_monotonic_server_side_analysis_stages(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            image = np.zeros((24, 30, 3), dtype=np.uint8)
            image[:, :15] = [220, 60, 80]
            image[:, 15:] = [50, 170, 210]
            source = workspace / "progress-fixture.png"
            Image.fromarray(image).save(source)
            events = []
            analyze(source, workspace / "output", {"maxImagePixels": 10_000, "scaleLevels": [1], "slicSegments": 12, "minimumRegionPixels": 2, "runScaleConsistency": False, "residualEnabled": False}, progress=lambda stage, percent, message: events.append((stage, percent, message)))
            self.assertEqual(events[0][0], "validating_input")
            self.assertEqual(events[-1][0], "analysis_complete")
            self.assertEqual([event[1] for event in events], sorted(event[1] for event in events))
            self.assertTrue(all(0 <= event[1] <= 100 and event[2] for event in events))
            self.assertTrue({"feature_extraction", "segmentation", "merge_tree", "relationship_graph", "reconstruction", "serialization"}.issubset({event[0] for event in events}))

    def test_cli_emits_jsonl_progress_before_its_compatible_completion_record(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            image = np.zeros((20, 24, 3), dtype=np.uint8)
            image[:, :12] = [200, 50, 80]
            image[:, 12:] = [40, 170, 220]
            source = workspace / "cli-progress.png"
            Image.fromarray(image).save(source)
            command = [sys.executable, str(Path(__file__).with_name("representation_engine.py")), "--input", str(source), "--output", str(workspace / "output"), "--config", json.dumps({"maxImagePixels": 10_000, "scaleLevels": [1], "slicSegments": 12, "minimumRegionPixels": 2, "runScaleConsistency": False, "residualEnabled": False})]
            completed = subprocess.run(command, cwd=Path(__file__).parent, check=True, capture_output=True, text=True)
            records = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            self.assertTrue(any(record.get("event") == "progress" for record in records[:-1]))
            self.assertTrue(records[-1]["ok"])
            self.assertIn("representationPath", records[-1])


if __name__ == "__main__":
    unittest.main()
