"""Deterministic initial segmentation and exact labelled-boundary utilities."""

from __future__ import annotations

from typing import Any, Dict, Set, Tuple

import numpy as np
from scipy.ndimage import binary_dilation
from skimage.color import rgb2gray
from skimage.filters import sobel
from skimage.segmentation import felzenszwalb, relabel_sequential, slic, watershed


def merge_tiny_regions(labels: np.ndarray, minimum_pixels: int) -> np.ndarray:
    labels = labels.astype(np.int32).copy()
    counts = np.bincount(labels.ravel())
    for label in range(1, len(counts)):
        if not counts[label] or counts[label] >= minimum_pixels:
            continue
        mask = labels == label
        candidates = labels[binary_dilation(mask) & ~mask]
        candidates = candidates[(candidates != label) & (candidates > 0)]
        if candidates.size:
            frequencies = np.bincount(candidates)
            replacement = int(np.flatnonzero(frequencies == frequencies.max())[0])
            if replacement > 0 and replacement != label:
                labels[mask] = replacement
    relabeled, _, _ = relabel_sequential(labels)
    return relabeled.astype(np.int32)


def _relabel(labels: np.ndarray) -> np.ndarray:
    relabeled, _, _ = relabel_sequential(labels.astype(np.int32))
    return relabeled.astype(np.int32)


def _grid_partition(shape: Tuple[int, int], target: int) -> np.ndarray:
    """Deterministic connected fallback that makes no semantic claim about noisy content."""
    height, width = shape
    target = max(2, min(int(target), height * width))
    rows = max(1, int(round(np.sqrt(target * height / max(width, 1)))))
    cols = max(1, int(np.ceil(target / rows)))
    y = np.minimum((np.arange(height) * rows) // height, rows - 1)
    x = np.minimum((np.arange(width) * cols) // width, cols - 1)
    return _relabel((y[:, None] * cols + x[None, :] + 1).astype(np.int32))


def _is_degenerate(count: int, requested_segments: int) -> bool:
    return count <= max(1, min(4, int(requested_segments) // 8))


def segment_slic(rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int, enforce_connectivity: bool = True) -> np.ndarray:
    labels = slic(rgb, n_segments=max(8, int(requested_segments)), compactness=float(compactness), start_label=1, channel_axis=-1, enforce_connectivity=enforce_connectivity, convert2lab=True)
    return merge_tiny_regions(labels, minimum_pixels)


def segment_watershed(rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    gradient = sobel(rgb2gray(rgb))
    labels = watershed(gradient, markers=max(8, int(requested_segments)), compactness=max(0.0, float(compactness) / 80.0))
    return merge_tiny_regions(labels.astype(np.int32) + 1, minimum_pixels)


def segment_felzenszwalb(rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    scale = max(40.0, 2600.0 / max(int(requested_segments), 8))
    labels = felzenszwalb(rgb, scale=scale, sigma=max(0.1, float(compactness) / 30.0), min_size=max(2, int(minimum_pixels)), channel_axis=-1)
    return merge_tiny_regions(labels.astype(np.int32) + 1, minimum_pixels)


def segment_image_with_diagnostics(rgb: np.ndarray, strategy: str, requested_segments: int, compactness: float, minimum_pixels: int, max_initial_segments: int = 320) -> Tuple[np.ndarray, Dict[str, Any]]:
    selected = str(strategy).lower()
    if selected == "slic":
        labels = segment_slic(rgb, requested_segments, compactness, minimum_pixels)
    elif selected == "watershed":
        labels = segment_watershed(rgb, requested_segments, compactness, minimum_pixels)
    elif selected == "felzenszwalb":
        labels = segment_felzenszwalb(rgb, requested_segments, compactness, minimum_pixels)
    else:
        raise ValueError(f"Unsupported segmentation strategy: {strategy}. Expected one of: slic, watershed, felzenszwalb.")
    raw_count = int(labels.max())
    action = "none"
    degenerate = _is_degenerate(raw_count, requested_segments)
    if selected == "slic" and degenerate:
        retry = segment_slic(rgb, requested_segments, compactness, minimum_pixels, enforce_connectivity=False)
        if not _is_degenerate(int(retry.max()), requested_segments):
            labels, action = retry, "slic_without_connectivity_retry"
        else:
            labels, action = _grid_partition(rgb.shape[:2], requested_segments), "deterministic_grid_fallback"
    if int(labels.max()) > max(8, int(max_initial_segments)):
        labels, action = _grid_partition(rgb.shape[:2], min(int(max_initial_segments), max(8, int(requested_segments)))), "deterministic_grid_reduction"
    labels = _relabel(labels)
    return labels, {"strategy": selected, "requestedSegments": int(requested_segments), "rawSegments": raw_count, "actualSegments": int(labels.max()), "degenerate": bool(degenerate), "fallbackAction": action, "maxInitialSegments": int(max_initial_segments)}


def segment_image(rgb: np.ndarray, strategy: str, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    return segment_image_with_diagnostics(rgb, strategy, requested_segments, compactness, minimum_pixels)[0]


def label_adjacency(labels: np.ndarray) -> Set[Tuple[int, int]]:
    pairs: Set[Tuple[int, int]] = set()
    for first, second in ((labels[:, :-1], labels[:, 1:]), (labels[:-1, :], labels[1:, :])):
        different = first != second
        for source, target in zip(first[different], second[different]):
            pairs.add((int(min(source, target)), int(max(source, target))))
    return pairs


def shared_boundary_lengths(labels: np.ndarray) -> Dict[Tuple[int, int], int]:
    lengths: Dict[Tuple[int, int], int] = {}
    for first, second in ((labels[:, :-1], labels[:, 1:]), (labels[:-1, :], labels[1:, :])):
        for source, target in zip(first.ravel(), second.ravel()):
            if source == target:
                continue
            key = (int(min(source, target)), int(max(source, target)))
            lengths[key] = lengths.get(key, 0) + 1
    return lengths
