import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class BenchmarkSuiteTest(unittest.TestCase):
    def test_generates_synthetic_records_and_codec_measurements(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "benchmark"
            subprocess.run(["python3", "python_engine/benchmark_suite.py", "--output", str(output)], check=True, cwd=Path(__file__).resolve().parents[1])
            report = json.loads((output / "benchmark-report.json").read_text())
            self.assertEqual(report["benchmarkVersion"], "0.5.0")
            self.assertTrue(report["researchPrototype"])
            self.assertEqual(len(report["records"]), 7)
            first = report["records"][0]
            self.assertEqual(first["provenance"], "synthetic")
            self.assertGreater(first["relationshipCount"], 0)
            self.assertTrue({"constant", "parametric", "residual"}.issubset(first["reconstructionModes"]))
            self.assertGreaterEqual(first["reconstructionModes"]["residual"]["psnr"], first["reconstructionModes"]["constant"]["psnr"])
            self.assertEqual(set(first["segmentationDiagnostics"]), {"slic", "watershed", "felzenszwalb"})
            self.assertGreater(first["residual"]["estimatedBytes"], 0)
            self.assertEqual(first["heuristicRateDistortion"]["basis"], "parameter_payload_estimate_not_serialized_storage")
            self.assertEqual(first["artifactStorage"]["basis"], "actual_emitted_file_bytes")
            self.assertTrue(first["codecComparisons"]["PNG"]["available"])
            self.assertGreater(first["codecComparisons"]["JPEG"]["outputBytes"], 0)
            self.assertIn("AVIF", first["codecComparisons"])
            natural_photo = next(record for record in report["records"] if record["category"] == "natural_photo_sample")
            self.assertEqual(natural_photo["provenance"], "bundled_real_photo")


if __name__ == "__main__":
    unittest.main()
