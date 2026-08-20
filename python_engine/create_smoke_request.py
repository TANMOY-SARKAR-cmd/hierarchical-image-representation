import base64
import json
from pathlib import Path

import numpy as np
from PIL import Image

fixture_path = Path("/tmp/hierarchical-image-fixture.png")
request_path = Path("/tmp/hierarchical-image-request.json")
image = np.zeros((48, 64, 3), dtype=np.uint8)
image[:, :21] = [225, 55, 60]
image[:, 21:43] = [40, 190, 135]
image[:, 43:] = [45, 105, 235]
Image.fromarray(image).save(fixture_path)
request_path.write_text(
    json.dumps(
        {
            "json": {
                "fileName": "integration-fixture.png",
                "mimeType": "image/png",
                "dataBase64": base64.b64encode(fixture_path.read_bytes()).decode("ascii"),
                "config": {
                    "maxFileSizeBytes": 1048576,
                    "maxImagePixels": 786432,
                    "groupingMethod": "slic",
                    "scaleLevels": [1, 2, 4, 8],
                    "slicSegments": 24,
                    "slicCompactness": 8,
                    "minimumRegionPixels": 2,
                    "hierarchyGroupSize": 3,
                    "runScaleConsistency": True,
                    "maxConsistencyPixels": 786432,
                },
            }
        }
    ),
    encoding="utf-8",
)
