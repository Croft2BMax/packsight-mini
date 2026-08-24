"""Train and evaluate the packaging order anomaly detection model."""

from datetime import datetime, timezone
from pathlib import Path
import json
import platform

import joblib
import pandas as pd
import sklearn
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import IsolationForest
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler


PROJECT_ROOT = Path(__file__).resolve().parents[1]

DATASET_PATH = PROJECT_ROOT / "data" / "historical_orders.csv"
ARTIFACT_DIRECTORY = PROJECT_ROOT / "artifacts"
MODEL_PATH = ARTIFACT_DIRECTORY / "isolation_forest.joblib"
METRICS_PATH = ARTIFACT_DIRECTORY / "metrics.json"

RANDOM_SEED = 42
TEST_SIZE = 0.20
CONTAMINATION = 0.05

REQUIRED_COLUMNS = {
    "order_id",
    "order_date",
    "completed_date",
    "product_type",
    "ordered_quantity",
    "produced_quantity",
    "defect_count",
    "unit_price",
    "is_injected_anomaly",
}

NUMERIC_FEATURES = [
    "ordered_quantity",
    "unit_price",
    "defect_rate",
    "lead_time_days",
    "order_value",
]

CATEGORICAL_FEATURES = [
    "product_type",
]

MODEL_FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES


def load_and_validate_dataset() -> pd.DataFrame:
    """Load the historical dataset and validate its raw values."""

    if not DATASET_PATH.exists():
        raise FileNotFoundError(
            f"Dataset tidak ditemukan: {DATASET_PATH}. "
            "Jalankan analytics/generate_data.py terlebih dahulu."
        )

    dataframe = pd.read_csv(DATASET_PATH)

    missing_columns = REQUIRED_COLUMNS - set(dataframe.columns)

    if missing_columns:
        missing_text = ", ".join(sorted(missing_columns))
        raise ValueError(
            f"Dataset kehilangan kolom wajib: {missing_text}"
        )

    if dataframe["order_id"].duplicated().any():
        duplicate_ids = (
            dataframe.loc[
                dataframe["order_id"].duplicated(),
                "order_id",
            ]
            .astype(str)
            .tolist()
        )

        raise ValueError(
            f"Order ID duplikat ditemukan: {duplicate_ids}"
        )

    numeric_raw_columns = [
        "ordered_quantity",
        "produced_quantity",
        "defect_count",
        "unit_price",
        "is_injected_anomaly",
    ]

    for column in numeric_raw_columns:
        dataframe[column] = pd.to_numeric(
            dataframe[column],
            errors="raise",
        )

    dataframe["order_date"] = pd.to_datetime(
        dataframe["order_date"],
        errors="raise",
    )

    dataframe["completed_date"] = pd.to_datetime(
        dataframe["completed_date"],
        errors="raise",
    )

    if (dataframe["ordered_quantity"] <= 0).any():
        raise ValueError(
            "ordered_quantity harus lebih besar dari nol."
        )

    if (dataframe["produced_quantity"] <= 0).any():
        raise ValueError(
            "produced_quantity harus lebih besar dari nol."
        )

    if (dataframe["unit_price"] < 0).any():
        raise ValueError(
            "unit_price tidak boleh negatif."
        )

    if (dataframe["defect_count"] < 0).any():
        raise ValueError(
            "defect_count tidak boleh negatif."
        )

    invalid_defect_count = (
        dataframe["defect_count"]
        > dataframe["produced_quantity"]
    )

    if invalid_defect_count.any():
        raise ValueError(
            "defect_count tidak boleh melebihi "
            "produced_quantity."
        )

    invalid_dates = (
        dataframe["completed_date"]
        < dataframe["order_date"]
    )

    if invalid_dates.any():
        raise ValueError(
            "completed_date tidak boleh sebelum order_date."
        )

    valid_labels = dataframe[
        "is_injected_anomaly"
    ].isin([0, 1])

    if not valid_labels.all():
        raise ValueError(
            "is_injected_anomaly hanya boleh berisi 0 atau 1."
        )

    if dataframe["product_type"].isna().any():
        raise ValueError(
            "product_type tidak boleh kosong."
        )

    return dataframe


def engineer_features(
    dataframe: pd.DataFrame,
) -> pd.DataFrame:
    """Create model features from raw operational columns."""

    result = dataframe.copy()

    result["lead_time_days"] = (
        result["completed_date"]
        - result["order_date"]
    ).dt.days

    result["defect_rate"] = (
        result["defect_count"]
        / result["produced_quantity"]
    )

    result["order_value"] = (
        result["ordered_quantity"]
        * result["unit_price"]
    )

    return result


def create_pipeline() -> Pipeline:
    """Create preprocessing and Isolation Forest pipeline."""

    preprocessor = ColumnTransformer(
        transformers=[
            (
                "numeric",
                StandardScaler(),
                NUMERIC_FEATURES,
            ),
            (
                "categorical",
                OneHotEncoder(
                    handle_unknown="ignore",
                    sparse_output=False,
                ),
                CATEGORICAL_FEATURES,
            ),
        ],
        remainder="drop",
    )

    model = IsolationForest(
        n_estimators=100,
        contamination=CONTAMINATION,
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )

    return Pipeline(
        steps=[
            ("preprocessor", preprocessor),
            ("model", model),
        ]
    )


def evaluate_model(
    y_true: pd.Series,
    raw_predictions,
) -> dict:
    """Convert predictions and calculate evaluation metrics."""

    # Isolation Forest:
    #  1 = normal
    # -1 = anomaly
    #
    # Label dataset:
    # 0 = normal
    # 1 = anomaly
    predicted_labels = (
        raw_predictions == -1
    ).astype(int)

    matrix = confusion_matrix(
        y_true,
        predicted_labels,
        labels=[0, 1],
    )

    true_negative, false_positive, false_negative, true_positive = (
        matrix.ravel()
    )

    report = classification_report(
        y_true,
        predicted_labels,
        labels=[0, 1],
        target_names=["normal", "anomaly"],
        output_dict=True,
        zero_division=0,
    )

    return {
        "precision_anomaly": round(
            float(report["anomaly"]["precision"]),
            4,
        ),
        "recall_anomaly": round(
            float(report["anomaly"]["recall"]),
            4,
        ),
        "f1_anomaly": round(
            float(report["anomaly"]["f1-score"]),
            4,
        ),
        "confusion_matrix": {
            "true_negative": int(true_negative),
            "false_positive": int(false_positive),
            "false_negative": int(false_negative),
            "true_positive": int(true_positive),
        },
    }


def main() -> None:
    """Train, evaluate, and save the model."""

    ARTIFACT_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )

    dataframe = load_and_validate_dataset()
    featured_dataframe = engineer_features(dataframe)

    features = featured_dataframe[MODEL_FEATURES]
    labels = featured_dataframe["is_injected_anomaly"]

    (
        training_features,
        testing_features,
        training_labels,
        testing_labels,
    ) = train_test_split(
        features,
        labels,
        test_size=TEST_SIZE,
        random_state=RANDOM_SEED,
        stratify=labels,
    )

    pipeline = create_pipeline()

    # Isolation Forest tidak menerima training_labels
    # karena model ini bersifat unsupervised.
    pipeline.fit(training_features)

    raw_predictions = pipeline.predict(testing_features)

    evaluation = evaluate_model(
        testing_labels,
        raw_predictions,
    )

    model_bundle = {
        "pipeline": pipeline,
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "model_features": MODEL_FEATURES,
        "metadata": {
            "model_name": "IsolationForest",
            "trained_at": datetime.now(
                timezone.utc
            ).isoformat(),
            "random_seed": RANDOM_SEED,
            "contamination": CONTAMINATION,
            "training_records": len(training_features),
            "python_version": platform.python_version(),
            "scikit_learn_version": sklearn.__version__,
        },
    }

    joblib.dump(
        model_bundle,
        MODEL_PATH,
    )

    metrics = {
        "model_name": "IsolationForest",
        "generated_at": datetime.now(
            timezone.utc
        ).isoformat(),
        "dataset": {
            "total_records": len(featured_dataframe),
            "total_injected_anomalies": int(labels.sum()),
            "training_records": len(training_features),
            "training_anomalies": int(training_labels.sum()),
            "testing_records": len(testing_features),
            "testing_anomalies": int(testing_labels.sum()),
        },
        "configuration": {
            "test_size": TEST_SIZE,
            "contamination": CONTAMINATION,
            "n_estimators": 100,
            "random_seed": RANDOM_SEED,
            "numeric_features": NUMERIC_FEATURES,
            "categorical_features": CATEGORICAL_FEATURES,
        },
        "evaluation": evaluation,
        "environment": {
            "python_version": platform.python_version(),
            "scikit_learn_version": sklearn.__version__,
        },
    }

    with METRICS_PATH.open(
        "w",
        encoding="utf-8",
    ) as metrics_file:
        json.dump(
            metrics,
            metrics_file,
            ensure_ascii=False,
            indent=2,
        )

    print("Training selesai.")
    print(f"Dataset records: {len(featured_dataframe)}")
    print(f"Training records: {len(training_features)}")
    print(f"Testing records: {len(testing_features)}")
    print(
        "Testing anomalies: "
        f"{int(testing_labels.sum())}"
    )
    print(
        "Precision anomaly: "
        f"{evaluation['precision_anomaly']:.4f}"
    )
    print(
        "Recall anomaly: "
        f"{evaluation['recall_anomaly']:.4f}"
    )
    print(
        "F1 anomaly: "
        f"{evaluation['f1_anomaly']:.4f}"
    )
    print(
        "Confusion matrix: "
        f"{evaluation['confusion_matrix']}"
    )
    print(f"Model artifact: {MODEL_PATH}")
    print(f"Metrics: {METRICS_PATH}")


if __name__ == "__main__":
    main()