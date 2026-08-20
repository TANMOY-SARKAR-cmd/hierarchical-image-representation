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
            self.assertEqual(report["benchmarkVersion"], "0.2.0")
            self.assertEqual(len(report["records"]), 7)
            first = report["records"][0]
            self.assertEqual(first["provenance"], "synthetic")
            self.assertGreater(first["relationshipCount"], 0)
            self.assertTrue(first["codecComparisons"]["PNG"]["available"])
            self.assertGreater(first["codecComparisons"]["JPEG"]["outputBytes"], 0)
            self.assertIn("AVIF", first["codecComparisons"])
            natural_photo = next(record for record in report["records"] if record["category"] == "natural_photo_sample")
            self.assertEqual(natural_photo["provenance"], "bundled_real_photo")


if __name__ == "__main__":
    unittest.main()
