"""Deterministic initial segmentation and exact labelled-boundary utilities."""

from __future__ import annotations

from typing import Dict, Set, Tuple

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
        candidates = candidates[candidates != label]
        if candidates.size:
            frequencies = np.bincount(candidates)
            replacement = int(np.flatnonzero(frequencies == frequencies.max())[0])
            if replacement:
                labels[mask] = replacement
    relabeled, _, _ = relabel_sequential(labels)
    return relabeled.astype(np.int32)


def segment_slic(rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    labels = slic(rgb, n_segments=max(8, int(requested_segments)), compactness=float(compactness), start_label=1, channel_axis=-1, enforce_connectivity=True, convert2lab=True)
    return merge_tiny_regions(labels, minimum_pixels)


def segment_watershed(rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    gradient = sobel(rgb2gray(rgb))
    labels = watershed(gradient, markers=max(8, int(requested_segments)), compactness=max(0.0, float(compactness) / 80.0))
    return merge_tiny_regions(labels.astype(np.int32) + 1, minimum_pixels)


def segment_felzenszwalb(rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    scale = max(40.0, 2600.0 / max(int(requested_segments), 8))
    labels = felzenszwalb(rgb, scale=scale, sigma=max(0.1, float(compactness) / 30.0), min_size=max(2, int(minimum_pixels)), channel_axis=-1)
    return merge_tiny_regions(labels.astype(np.int32) + 1, minimum_pixels)


def segment_image(rgb: np.ndarray, strategy: str, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    selected = str(strategy).lower()
    if selected == "watershed":
        return segment_watershed(rgb, requested_segments, compactness, minimum_pixels)
    if selected == "felzenszwalb":
        return segment_felzenszwalb(rgb, requested_segments, compactness, minimum_pixels)
    return segment_slic(rgb, requested_segments, compactness, minimum_pixels)


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
