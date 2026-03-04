"""
HDBSCAN clustering for issue embeddings.

Reads: embeddings.json  (from Node.js DB extract)
  Format: [{ "issueNumber": int, "embedding": [float...], "productLabel": str, ... }, ...]

Writes: clusters.json  (for Node.js to write back to DB)
  Format: [{ "issueNumber": int, "clusterId": int, "productLabel": str, "similarity": float }, ...]
  clusterId = -1 means noise/outlier
"""

import json
import sys
import numpy as np
from collections import defaultdict

import hdbscan

def cosine_similarity(a, b):
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return dot / norm if norm > 0 else 0.0

def cluster_product(issues, min_cluster_size=3, min_samples=2):
    """Run HDBSCAN on a set of issues for one product."""
    if len(issues) < min_cluster_size:
        # Too few issues — put all in one cluster
        return [{"clusterId": 0, "similarity": 1.0, **iss} for iss in issues]

    embeddings = np.array([iss["embedding"] for iss in issues])

    # Normalize for cosine distance
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normalized = embeddings / norms

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="euclidean",  # on normalized vectors ≈ cosine
        cluster_selection_method="eom",
    )
    labels = clusterer.fit_predict(normalized)

    # Compute centroids for each cluster
    centroids = {}
    for label in set(labels):
        if label == -1:
            continue
        mask = labels == label
        centroid = normalized[mask].mean(axis=0)
        centroid = centroid / np.linalg.norm(centroid)  # re-normalize
        centroids[label] = centroid

    results = []
    for i, iss in enumerate(issues):
        label = int(labels[i])
        if label >= 0 and label in centroids:
            sim = float(cosine_similarity(normalized[i], centroids[label]))
        else:
            sim = 0.0
        results.append({
            "issueNumber": iss["issueNumber"],
            "productLabel": iss["productLabel"],
            "clusterId": label,
            "similarity": round(sim, 4),
        })

    return results


def main():
    input_file = sys.argv[1] if len(sys.argv) > 1 else "embeddings.json"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "clusters.json"
    min_cluster_size = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    min_samples = int(sys.argv[4]) if len(sys.argv) > 4 else 2

    with open(input_file, "r") as f:
        issues = json.load(f)

    print(f"Loaded {len(issues)} issues from {input_file}")

    # Group by product label
    by_product = defaultdict(list)
    for iss in issues:
        by_product[iss["productLabel"]].append(iss)

    all_results = []
    for product, product_issues in sorted(by_product.items()):
        results = cluster_product(product_issues, min_cluster_size, min_samples)
        n_clusters = len(set(r["clusterId"] for r in results if r["clusterId"] >= 0))
        n_noise = sum(1 for r in results if r["clusterId"] < 0)
        print(f"  {product}: {len(product_issues)} issues → {n_clusters} clusters, {n_noise} outliers")
        all_results.extend(results)

    with open(output_file, "w") as f:
        json.dump(all_results, f)

    n_total_clusters = len(set(
        (r["productLabel"], r["clusterId"]) for r in all_results if r["clusterId"] >= 0
    ))
    print(f"\nTotal: {len(all_results)} issues, {n_total_clusters} clusters → {output_file}")


if __name__ == "__main__":
    main()
