"""Run tools/blender/tests inside Blender (headless):

    blender -b --factory-startup --python-exit-code 1 -P tools/blender/tests/run_tests.py [-- -k pattern]

or simply ``bash scripts/build-stages.sh --test``. Exit code 1 on any failure.
"""

import os
import sys
import unittest

sys.dont_write_bytecode = True
TESTS = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(TESTS)
for p in (TOOLS, TESTS):
    if p not in sys.path:
        sys.path.insert(0, p)


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    pattern = argv[argv.index("-k") + 1] if "-k" in argv else None
    loader = unittest.TestLoader()
    if pattern:
        loader.testNamePatterns = [f"*{pattern}*"]
    suite = loader.discover(TESTS, pattern="test_*.py", top_level_dir=TESTS)
    result = unittest.TextTestRunner(verbosity=1, stream=sys.stdout).run(suite)
    return 0 if result.wasSuccessful() and result.testsRun > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
