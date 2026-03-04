"""
HDBSCAN clustering + t-SNE visualization → interactive HTML.

Reads: embeddings.json
Outputs: clusters.json + clusters_visualization.html

Usage: python visualize_clusters.py [embeddings.json] [min_cluster_size] [min_samples]
"""

import json
import sys
import os
import numpy as np
from collections import defaultdict
from sklearn.manifold import TSNE
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import hdbscan


SKIP_PRODUCTS = {"Product-Uncategorized"}


def cosine_similarity(a, b):
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return dot / norm if norm > 0 else 0.0


def cluster_product(issues, min_cluster_size=2, min_samples=2, sim_threshold=0.85):
    if len(issues) < min_cluster_size:
        return [{"clusterId": -1, "similarity": 0.0, **iss} for iss in issues], None

    embeddings = np.array([iss["embedding"] for iss in issues])
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normalized = embeddings / norms

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="euclidean",
        cluster_selection_method="leaf",       # tighter, smaller clusters
        cluster_selection_epsilon=0.0,         # no merging
    )
    labels = clusterer.fit_predict(normalized)

    # Compute centroids
    centroids = {}
    for label in set(labels):
        if label == -1:
            continue
        mask = labels == label
        centroid = normalized[mask].mean(axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid = centroid / norm
        centroids[label] = centroid

    # Filter: demote clusters where ANY member is below sim_threshold
    for label, centroid in list(centroids.items()):
        mask = labels == label
        idxs = np.where(mask)[0]
        sims = [float(cosine_similarity(normalized[i], centroid)) for i in idxs]
        if min(sims) < sim_threshold:
            # Demote entire cluster to noise
            labels[mask] = -1
            del centroids[label]

    # Re-number surviving clusters 0..N
    old_labels = sorted(set(labels) - {-1})
    remap = {old: new for new, old in enumerate(old_labels)}
    new_centroids = {remap[old]: centroids[old] for old in old_labels}

    results = []
    for i, iss in enumerate(issues):
        old_label = int(labels[i])
        label = remap.get(old_label, -1)
        sim = float(cosine_similarity(normalized[i], new_centroids[label])) if label >= 0 else 0.0
        results.append({
            "issueNumber": iss["issueNumber"],
            "productLabel": iss["productLabel"],
            "title": iss.get("title", f"#{iss['issueNumber']}"),
            "clusterId": label,
            "similarity": round(sim, 4),
        })

    return results, normalized


def run_tsne_for_product(normalized_embeddings, perplexity=30):
    """Run t-SNE on normalized embeddings for 2D projection."""
    n = len(normalized_embeddings)
    perp = min(perplexity, max(5, n // 4))
    tsne = TSNE(n_components=2, perplexity=perp, random_state=42, max_iter=1000)
    return tsne.fit_transform(normalized_embeddings)


def generate_html(all_products_data, output_file):
    """Generate interactive HTML focused on duplicate detection."""
    # Sort products by number of dup groups descending
    products_sorted = sorted(all_products_data.items(), key=lambda x: x[1]["n_clusters"], reverse=True)
    # Also keep products with 0 clusters at end for reference
    products_with_dupes = [(p, d) for p, d in products_sorted if d["n_clusters"] > 0]
    products_without = [(p, d) for p, d in products_sorted if d["n_clusters"] == 0]

    html_parts = []
    html_parts.append("""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Issue Duplicate Detection</title>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 10px; }
  h2 { color: #8b949e; margin-top: 40px; }
  h3 { color: #c9d1d9; margin-top: 24px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .summary { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .summary table { width: 100%; border-collapse: collapse; }
  .summary th, .summary td { text-align: left; padding: 6px 12px; border-bottom: 1px solid #21262d; }
  .summary th { color: #8b949e; font-weight: 600; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0; }
  .stat { background: #21262d; border-radius: 6px; padding: 8px 16px; }
  .stat-value { font-size: 1.4em; font-weight: bold; color: #58a6ff; }
  .stat-label { font-size: 0.85em; color: #8b949e; }
  .dup-group { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .dup-group h4 { margin: 0 0 8px 0; color: #58a6ff; }
  .dup-table { width: 100%; border-collapse: collapse; }
  .dup-table th, .dup-table td { padding: 6px 12px; text-align: left; border-bottom: 1px solid #21262d; font-size: 0.9em; }
  .dup-table th { color: #8b949e; }
  .sim-high { color: #3fb950; font-weight: bold; }
  .sim-mid { color: #d29922; }
  .product-section { margin: 32px 0; border-top: 1px solid #30363d; padding-top: 16px; }
  .plot-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .product-nav { position: sticky; top: 0; background: #0d1117; padding: 10px 0; z-index: 100; border-bottom: 1px solid #30363d; }
  .product-nav select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 12px; border-radius: 6px; font-size: 14px; }
</style>
</head><body>
<h1>🔍 Issue Duplicate Detection (HDBSCAN)</h1>
""")

    # Global summary
    total_issues = sum(len(d["results"]) for d in all_products_data.values())
    total_groups = sum(d["n_clusters"] for d in all_products_data.values())
    total_dupes = sum(sum(1 for r in d["results"] if r["clusterId"] >= 0) for d in all_products_data.values())

    html_parts.append(f"""
<div class="stats">
  <div class="stat"><div class="stat-value">{total_issues}</div><div class="stat-label">Total Issues</div></div>
  <div class="stat"><div class="stat-value">{total_groups}</div><div class="stat-label">Duplicate Groups</div></div>
  <div class="stat"><div class="stat-value">{total_dupes}</div><div class="stat-label">Duplicate Issues</div></div>
  <div class="stat"><div class="stat-value">{len(products_with_dupes)}</div><div class="stat-label">Products with Dupes</div></div>
</div>
""")

    # Navigation
    html_parts.append('<div class="product-nav"><select id="product-select" onchange="showProduct(this.value)">')
    html_parts.append('<option value="all-dupes">🔍 All Duplicate Groups</option>')
    html_parts.append('<option value="summary">📊 Summary Table</option>')
    for product, data in products_with_dupes:
        html_parts.append(f'<option value="{product}">{product} ({data["n_clusters"]} dup groups)</option>')
    html_parts.append('</select></div>')

    # ---- ALL DUPES view (default) ----
    html_parts.append('<div id="section-all-dupes">')
    html_parts.append('<h2>All Duplicate Groups (sorted by similarity)</h2>')

    # Collect all dup groups across products
    all_groups = []
    for product, data in products_sorted:
        cluster_groups = defaultdict(list)
        for r in data["results"]:
            if r["clusterId"] >= 0:
                cluster_groups[r["clusterId"]].append(r)
        for cid, members in cluster_groups.items():
            members.sort(key=lambda x: x["similarity"], reverse=True)
            avg_sim = sum(m["similarity"] for m in members) / len(members)
            all_groups.append({"product": product, "cid": cid, "members": members, "avg_sim": avg_sim})

    all_groups.sort(key=lambda g: g["avg_sim"], reverse=True)

    for i, g in enumerate(all_groups):
        sim_class = "sim-high" if g["avg_sim"] >= 0.92 else "sim-mid"
        html_parts.append(f'<div class="dup-group">')
        html_parts.append(f'<h4>{g["product"]} — Dup Group {g["cid"]+1} <span class="{sim_class}">(avg similarity: {g["avg_sim"]:.3f})</span> — {len(g["members"])} issues</h4>')
        html_parts.append('<table class="dup-table"><tr><th>Issue</th><th>Title</th><th>Similarity to Centroid</th></tr>')
        for m in g["members"]:
            sc = "sim-high" if m["similarity"] >= 0.92 else "sim-mid"
            html_parts.append(f'<tr><td><a href="https://github.com/microsoft/PowerToys/issues/{m["issueNumber"]}" target="_blank">#{m["issueNumber"]}</a></td>'
                            f'<td>{m["title"][:120]}</td><td class="{sc}">{m["similarity"]:.3f}</td></tr>')
        html_parts.append('</table></div>')

    html_parts.append('</div>')

    # ---- Summary table ----
    html_parts.append('<div id="section-summary" class="summary" style="display:none"><h2>All Products Summary</h2><table><tr><th>Product</th><th>Issues</th><th>Dup Groups</th><th>Dup Issues</th></tr>')
    for product, data in products_sorted:
        n = len(data["results"])
        n_dupes_p = sum(1 for r in data["results"] if r["clusterId"] >= 0)
        if data["n_clusters"] > 0:
            html_parts.append(f'<tr><td>{product}</td><td>{n}</td><td>{data["n_clusters"]}</td><td>{n_dupes_p}</td></tr>')
    html_parts.append('</table></div>')

    # ---- Per-product sections with t-SNE ----
    for product, data in products_with_dupes:
        results = data["results"]
        html_parts.append(f'<div id="section-{product}" class="product-section" style="display:none">')
        html_parts.append(f'<h2>{product}</h2>')

        cluster_groups = defaultdict(list)
        for r in results:
            if r["clusterId"] >= 0:
                cluster_groups[r["clusterId"]].append(r)

        for cid in sorted(cluster_groups.keys()):
            members = cluster_groups[cid]
            members.sort(key=lambda x: x["similarity"], reverse=True)
            avg_sim = sum(m["similarity"] for m in members) / len(members)
            sim_class = "sim-high" if avg_sim >= 0.92 else "sim-mid"
            html_parts.append(f'<div class="dup-group">')
            html_parts.append(f'<h4>Dup Group {cid+1} <span class="{sim_class}">(avg sim: {avg_sim:.3f})</span> — {len(members)} issues</h4>')
            html_parts.append('<table class="dup-table"><tr><th>Issue</th><th>Title</th><th>Similarity</th></tr>')
            for m in members:
                sc = "sim-high" if m["similarity"] >= 0.92 else "sim-mid"
                html_parts.append(f'<tr><td><a href="https://github.com/microsoft/PowerToys/issues/{m["issueNumber"]}" target="_blank">#{m["issueNumber"]}</a></td>'
                                f'<td>{m["title"][:120]}</td><td class="{sc}">{m["similarity"]:.3f}</td></tr>')
            html_parts.append('</table></div>')

        # t-SNE plot
        coords = data.get("tsne_coords")
        if coords is not None:
            plot_div = f"plot-{product}"
            html_parts.append(f'<div class="plot-container"><div id="{plot_div}" style="width:100%;height:600px;"></div></div>')

            traces = []
            labels_set = sorted(set(r["clusterId"] for r in results))
            colors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#79c0ff','#56d364','#e3b341','#ff7b72','#d2a8ff']

            for label in labels_set:
                mask = [i for i, r in enumerate(results) if r["clusterId"] == label]
                x = [float(coords[i][0]) for i in mask]
                y = [float(coords[i][1]) for i in mask]
                texts = [f"#{results[i]['issueNumber']}: {results[i]['title'][:60]}" for i in mask]

                if label == -1:
                    traces.append({"x": x, "y": y, "text": texts, "mode": "markers",
                        "name": f"Unique ({len(mask)})", "marker": {"color": "#484f58", "size": 3, "opacity": 0.3},
                        "type": "scatter", "hoverinfo": "text"})
                else:
                    color = colors[label % len(colors)]
                    traces.append({"x": x, "y": y, "text": texts, "mode": "markers",
                        "name": f"Dup {label+1} ({len(mask)})", "marker": {"color": color, "size": 9, "opacity": 0.9},
                        "type": "scatter", "hoverinfo": "text"})

            layout = {"title": f"{product} — Duplicate Groups (t-SNE)", "paper_bgcolor": "#161b22", "plot_bgcolor": "#0d1117",
                "font": {"color": "#c9d1d9"}, "xaxis": {"showgrid": False, "zeroline": False, "showticklabels": False},
                "yaxis": {"showgrid": False, "zeroline": False, "showticklabels": False},
                "legend": {"bgcolor": "#161b2200"}, "hovermode": "closest"}
            html_parts.append(f'<script>Plotly.newPlot("{plot_div}", {json.dumps(traces)}, {json.dumps(layout)});</script>')

        html_parts.append('</div>')

    # Navigation script
    html_parts.append("""
<script>
function showProduct(value) {
  document.querySelectorAll('[id^="section-"]').forEach(el => el.style.display = 'none');
  document.getElementById('section-' + value).style.display = 'block';
  // Trigger plotly relayout for proper sizing
  const plot = document.querySelector('#section-' + value + ' [id^="plot-"]');
  if (plot) Plotly.Plots.resize(plot);
}
</script>
</body></html>""")

    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(html_parts))
    print(f"\nVisualization saved to {output_file}")


def main():
    input_file = sys.argv[1] if len(sys.argv) > 1 else "embeddings.json"
    min_cluster_size = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    min_samples = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    sim_threshold = float(sys.argv[4]) if len(sys.argv) > 4 else 0.85

    script_dir = os.path.dirname(os.path.abspath(__file__))

    with open(input_file, "r", encoding="utf-8") as f:
        issues = json.load(f)

    print(f"Loaded {len(issues)} issues from {input_file}")

    # Add title field from issue data if present
    for iss in issues:
        if "title" not in iss:
            iss["title"] = f"Issue #{iss['issueNumber']}"

    # Group by product, skip uncategorized
    by_product = defaultdict(list)
    skipped = 0
    for iss in issues:
        if iss["productLabel"] in SKIP_PRODUCTS:
            skipped += 1
            continue
        by_product[iss["productLabel"]].append(iss)

    print(f"Skipped {skipped} issues from {SKIP_PRODUCTS}")
    print(f"Processing {len(by_product)} products: min_cluster_size={min_cluster_size}, min_samples={min_samples}, sim_threshold={sim_threshold}\n")

    all_products_data = {}
    all_results = []

    for product, product_issues in sorted(by_product.items()):
        results, normalized = cluster_product(product_issues, min_cluster_size, min_samples, sim_threshold)
        n_clusters = len(set(r["clusterId"] for r in results if r["clusterId"] >= 0))
        n_dupes = sum(1 for r in results if r["clusterId"] >= 0)
        print(f"  {product}: {len(product_issues)} issues → {n_clusters} dup groups ({n_dupes} issues)")

        # Run t-SNE for products with enough issues
        tsne_coords = None
        if normalized is not None and len(product_issues) >= 10:
            try:
                tsne_coords = run_tsne_for_product(normalized).tolist()
            except Exception as e:
                print(f"    t-SNE failed: {e}")

        all_products_data[product] = {
            "results": results,
            "n_clusters": n_clusters,
            "n_dupes": n_dupes,
            "tsne_coords": tsne_coords,
        }
        all_results.extend(results)

    # Save clusters.json (without embeddings, for optional DB write later)
    clusters_file = os.path.join(script_dir, "clusters.json")
    json.dump(all_results, open(clusters_file, "w", encoding="utf-8"))
    n_total = len(set((r["productLabel"], r["clusterId"]) for r in all_results if r["clusterId"] >= 0))
    print(f"\nTotal: {len(all_results)} issues, {n_total} clusters → {clusters_file}")

    # Generate HTML visualization
    html_file = os.path.join(script_dir, "clusters_visualization.html")
    generate_html(all_products_data, html_file)


if __name__ == "__main__":
    main()
