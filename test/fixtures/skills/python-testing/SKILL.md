---
name: python-testing
description: Use when writing or fixing Python tests with pytest - fixtures, mocking, parametrized tests and coverage.
---

# Python testing with pytest

## Test layout

Put tests in a `tests/` folder with files named `test_*.py`. Each test is a plain function whose
name starts with `test_`. Run them with `pytest -q`, a single file with `pytest tests/test_api.py`,
and a single test with `pytest -k name`.

## Fixtures

Use fixtures for setup that several tests share. Define them with `@pytest.fixture` in the test file
or in `conftest.py`. Use `yield` inside a fixture to run cleanup code after the test. Built-in
fixtures such as `tmp_path` and `monkeypatch` cover temporary files and environment changes.

## Mocking

Replace slow or external dependencies with `unittest.mock.patch` or the `mocker` fixture from
pytest-mock. Patch the name where it is looked up, not where it is defined. Assert calls with
`mock.assert_called_once_with(...)`.

## Parametrized tests

Run one test over many inputs with `@pytest.mark.parametrize("value, expected", [...])`. Give each
case an `id` so failures are easy to read.

## Coverage

Measure coverage with `pytest --cov=package --cov-report=term-missing` and add tests for the lines
listed as missing. Do not chase 100 percent; cover the behaviour that matters.
