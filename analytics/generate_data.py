"""Generate reproducible synthetic packaging order datasets."""

from datetime import date, timedelta
from pathlib import Path
import json

import numpy as np
import pandas as pd


# Path proyek ditentukan dari lokasi file ini.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIRECTORY = PROJECT_ROOT / "data"

RANDOM_SEED = 42
HISTORICAL_RECORD_COUNT = 500
HISTORICAL_ANOMALY_FRACTION = 0.05
INCOMING_RECORD_COUNT = 30


# Setiap produk memiliki pola quantity, harga, dan lead time berbeda.
PRODUCT_PROFILES = {
    "Corrugated Box": {
        "quantity_mean": 550,
        "quantity_std": 120,
        "unit_price_mean": 6500,
        "unit_price_std": 900,
        "lead_time_mean": 5,
    },
    "Flexible Pouch": {
        "quantity_mean": 2000,
        "quantity_std": 400,
        "unit_price_mean": 1800,
        "unit_price_std": 300,
        "lead_time_mean": 6,
    },
    "Product Label": {
        "quantity_mean": 3000,
        "quantity_std": 600,
        "unit_price_mean": 900,
        "unit_price_std": 150,
        "lead_time_mean": 4,
    },
    "Folding Carton": {
        "quantity_mean": 800,
        "quantity_std": 180,
        "unit_price_mean": 4500,
        "unit_price_std": 700,
        "lead_time_mean": 6,
    },
}


def create_order(
    rng: np.random.Generator,
    order_id: str,
    order_date: date,
    anomaly_type: str | None = None,
) -> dict:
    """Create one internally consistent packaging production order."""

    product_type = str(rng.choice(list(PRODUCT_PROFILES)))
    profile = PRODUCT_PROFILES[product_type]

    ordered_quantity = max(
        50,
        int(
            round(
                rng.normal(
                    profile["quantity_mean"],
                    profile["quantity_std"],
                )
            )
        ),
    )

    unit_price = max(
        100,
        int(
            round(
                rng.normal(
                    profile["unit_price_mean"],
                    profile["unit_price_std"],
                )
            )
        ),
    )

    lead_time_days = int(
        np.clip(
            round(rng.normal(profile["lead_time_mean"], 1.2)),
            2,
            10,
        )
    )

    # Normal defect rate berada di sekitar 0,3% sampai 6%.
    generated_defect_rate = float(
        np.clip(
            rng.normal(loc=0.025, scale=0.012),
            0.003,
            0.06,
        )
    )

    # Suntikkan pola tidak normal untuk kebutuhan demonstrasi.
    if anomaly_type == "unusual_quantity":
        ordered_quantity = int(
            round(ordered_quantity * rng.uniform(2.8, 4.0))
        )

    elif anomaly_type == "high_defect":
        generated_defect_rate = float(rng.uniform(0.12, 0.25))

    elif anomaly_type == "long_lead_time":
        lead_time_days = int(rng.integers(14, 21))

    # Pabrik membuat sedikit buffer di atas jumlah pesanan.
    production_buffer = float(rng.uniform(0.02, 0.08))
    produced_quantity = int(
        round(ordered_quantity * (1 + production_buffer))
    )

    defect_count = int(
        round(produced_quantity * generated_defect_rate)
    )

    # Menjamin defect_count tetap masuk akal.
    defect_count = max(
        0,
        min(defect_count, produced_quantity),
    )

    completed_date = order_date + timedelta(days=lead_time_days)

    return {
        "order_id": order_id,
        "order_date": order_date.isoformat(),
        "completed_date": completed_date.isoformat(),
        "product_type": product_type,
        "ordered_quantity": ordered_quantity,
        "produced_quantity": produced_quantity,
        "defect_count": defect_count,
        "unit_price": unit_price,
        "is_injected_anomaly": int(anomaly_type is not None),
    }


def generate_historical_orders(
    rng: np.random.Generator,
) -> list[dict]:
    """Generate historical orders used for model training."""

    anomaly_count = int(
        HISTORICAL_RECORD_COUNT
        * HISTORICAL_ANOMALY_FRACTION
    )

    anomaly_indices = {
        int(index)
        for index in rng.choice(
            HISTORICAL_RECORD_COUNT,
            size=anomaly_count,
            replace=False,
        )
    }

    anomaly_types = [
        "high_defect",
        "long_lead_time",
        "unusual_quantity",
    ]

    historical_start_date = date(2025, 1, 1)
    orders = []

    for index in range(HISTORICAL_RECORD_COUNT):
        anomaly_type = None

        if index in anomaly_indices:
            anomaly_type = anomaly_types[index % len(anomaly_types)]

        order = create_order(
            rng=rng,
            order_id=f"HIST-{index + 1:04d}",
            order_date=historical_start_date + timedelta(days=index),
            anomaly_type=anomaly_type,
        )

        orders.append(order)

    return orders


def generate_incoming_orders(
    rng: np.random.Generator,
) -> list[dict]:
    """Generate recently completed orders used by the workflow."""

    # Posisi tiga anomali dibuat tetap agar demo reproducible.
    anomaly_mapping = {
        7: "high_defect",
        18: "long_lead_time",
        26: "unusual_quantity",
    }

    incoming_start_date = date(2026, 7, 20)
    orders = []

    for index in range(INCOMING_RECORD_COUNT):
        order = create_order(
            rng=rng,
            order_id=f"INC-{index + 1:03d}",
            order_date=(
                incoming_start_date
                + timedelta(days=index % 10)
            ),
            anomaly_type=anomaly_mapping.get(index),
        )

        orders.append(order)

    return orders


def main() -> None:
    """Generate and save both datasets."""

    DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(RANDOM_SEED)

    historical_orders = generate_historical_orders(rng)
    incoming_orders = generate_incoming_orders(rng)

    historical_dataframe = pd.DataFrame(historical_orders)

    historical_path = DATA_DIRECTORY / "historical_orders.csv"
    incoming_path = DATA_DIRECTORY / "incoming_orders.json"

    historical_dataframe.to_csv(
        historical_path,
        index=False,
    )

    with incoming_path.open(
        "w",
        encoding="utf-8",
    ) as output_file:
        json.dump(
            incoming_orders,
            output_file,
            ensure_ascii=False,
            indent=2,
        )

    historical_anomaly_count = int(
        historical_dataframe["is_injected_anomaly"].sum()
    )

    incoming_anomaly_count = sum(
        order["is_injected_anomaly"]
        for order in incoming_orders
    )

    print(f"Historical dataset: {historical_path}")
    print(f"Historical records: {len(historical_orders)}")
    print(f"Historical anomalies: {historical_anomaly_count}")
    print(f"Incoming dataset: {incoming_path}")
    print(f"Incoming records: {len(incoming_orders)}")
    print(f"Incoming anomalies: {incoming_anomaly_count}")


if __name__ == "__main__":
    main()