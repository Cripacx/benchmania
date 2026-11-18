"""benchcore: the domain-independent engine behind the benchmark platform.

The engine loads declarative manifests (domains, scenarios, implementations), runs them through a
domain harness, collects metrics from the operating system and load generators, and writes
schema-versioned result bundles that the website and other tools consume.
"""

__version__ = "1.0.0"
RESULT_SCHEMA = "benchcore.result/v1"
DATASET_SCHEMA = "benchcore.dataset/v1"
