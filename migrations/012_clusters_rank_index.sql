-- 012_clusters_rank_index.sql
-- Speed up cluster listing by repo/product ordered by popularity.

create index if not exists clusters_repo_product_popularity_idx
  on clusters (repo, product_label, popularity desc, size desc, updated_at desc);
