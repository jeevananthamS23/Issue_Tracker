# CivicVision AI — Phase 1 Test Evaluation Report

**Evaluation Timestamp:** 2026-10-27T08:03:24.536773+00:00  
**Checkpoint Evaluated:** `best_model.pt` (Epoch 8 Best Checkpoint)  
**Evaluated Split:** Held-out RDD2022 Test Split ($N = 2,408$)  
**Inference Device:** cpu  
**Elapsed Evaluation Time:** 98.52 seconds  

---

## 1. Executive Summary: Test vs Validation Performance

| Metric | Validation Set (N=2,371) | Test Set (N=2,408) | Generalization Delta |
| :--- | :---: | :---: | :---: |
| **Average Loss** | `0.5552` | **`0.5307`** | -0.0245 |
| **Macro-F1** | `79.11%` | **`78.47%`** | **-0.64%** |
| **Macro-Precision** | — | **`76.77%`** | — |
| **Macro-Recall** | — | **`80.33%`** | — |
| **Exact Match Accuracy** | — | **`76.95%`** | (1853 / 2408 images) |
| **Hamming Accuracy** | — | **`87.44%`** | (Label-level accuracy) |

---

## 2. Per-Class Test Breakdown (Using Frozen Validation Thresholds)

### Category: `pothole`
- **Threshold ($\tau^*$):** `0.75` *(Selected on Validation set, applied frozen)*
- **F1 Score:** **`66.97%`** *(Validation: 69.34%)*
- **Precision:** `67.13%` *(Validation: 67.51%)*
- **Recall:** `66.82%` *(Validation: 71.27%)*
- **Accuracy:** `88.12%`
- **Confusion Matrix:**
  $$\begin{pmatrix} \text{TN} = 1832 & \text{FP} = 142 \\ \text{FN} = 144 & \text{TP} = 290 \end{pmatrix}$$

### Category: `road_damage`
- **Threshold ($\tau^*$):** `0.35` *(Selected on Validation set, applied frozen)*
- **F1 Score:** **`89.97%`** *(Validation: 88.87%)*
- **Precision:** `86.40%` *(Validation: 84.16%)*
- **Recall:** `93.83%` *(Validation: 94.14%)*
- **Accuracy:** `86.75%`
- **Confusion Matrix:**
  $$\begin{pmatrix} \text{TN} = 659 & \text{FP} = 225 \\ \text{FN} = 94 & \text{TP} = 1430 \end{pmatrix}$$

---

## 3. Dataset Quarantine & Integrity Verification

1. **Strict Split Separation:**  
   - Train Split ($N = 11,060$): zero intersection with Test.  
   - Validation Split ($N = 2,371$): zero intersection with Test.  
   - Test Split ($N = 2,408$): 100% held-out; no tuning, no threshold search, evaluated exactly once.
2. **Zero Unannotated Data Leakage:**  
   - TACO images: Excluded (0 samples).  
   - Both categories supervised (`label_masks == 1` for all 2,408 images).
3. **Reproducibility:**  
   - Deterministic test transforms (`Resize(256)`, `CenterCrop(224)`, ImageNet normalization).  
   - Random seed `42`.
