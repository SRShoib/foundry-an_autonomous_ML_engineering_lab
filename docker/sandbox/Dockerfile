FROM python:3.11-slim

# Pinned to pandas 2.x (not the new 3.x line) — LLM-generated training code is trained
# overwhelmingly on 2.x idioms; this protects the runner's self-debug budget (M3, k=3 attempts)
# from being burned on pandas-3 behavior changes instead of real modeling bugs.
RUN pip install --no-cache-dir \
    pandas==2.3.3 \
    numpy==2.2.6 \
    scikit-learn==1.9.0 \
    scipy==1.17.1

RUN useradd --create-home --uid 1000 sandbox
USER sandbox
WORKDIR /workspace

ENTRYPOINT ["python"]
