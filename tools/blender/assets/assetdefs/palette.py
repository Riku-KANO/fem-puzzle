"""Shared colours (authored as sRGB hex, stored linear).

The environment is kept muted and warm so the stress colour map on the part (blue → red,
magenta for overload) stays the most saturated thing on screen. Load jigs use safety
yellow/black so the load direction pops; supports are dark steel with machined faces.
"""

from assetkit.geo import hexrgb

# room
FLOOR = hexrgb("#6a6762")
FLOOR_MAT = hexrgb("#2b2c2e")
WALL_HIGH = hexrgb("#a49d91")
WALL_LOW = hexrgb("#4b5a5c")
RAIL = hexrgb("#33393b")
SKIRTING = hexrgb("#2c3032")
CEILING = hexrgb("#8b8780")
WINDOW_FRAME = hexrgb("#dcd8cf")
SKY_HIGH = hexrgb("#a9c8e8")
SKY_LOW = hexrgb("#e6eef2")
DOOR = hexrgb("#6b5140")
LAMP_SHADE = hexrgb("#2f4f3e")
LAMP_INNER = hexrgb("#f2ead6")
BULB = hexrgb("#fff3d0")
TUBE = hexrgb("#f4f7ff")
HOUSING = hexrgb("#c9c9c4")

# furniture / props
WOOD = (hexrgb("#a97d52"), hexrgb("#9e7249"), hexrgb("#b2875c"), hexrgb("#986d45"))
WOOD_DARK = hexrgb("#7a5532")
FRAME = hexrgb("#3c4349")
PEGBOARD = hexrgb("#a57a4e")
PEG_HOLE = hexrgb("#3a2a1c")
CABINET = hexrgb("#9c3a30")
CABINET_DARK = hexrgb("#7e2d25")
CHROME = hexrgb("#c6cacd")
STEEL = hexrgb("#8d949a")
RUBBER = hexrgb("#222324")
ALU = hexrgb("#c3c7cb")
CARDBOARD = hexrgb("#b08d5f")
PAPER = hexrgb("#efe9da")
INK = hexrgb("#4a4f57")
BLUEPRINT = hexrgb("#27507a")
BLUEPRINT_LINE = hexrgb("#d6e2ee")
PLANT = hexrgb("#4f7a3f")
PLANT_DARK = hexrgb("#3c5f33")
TERRACOTTA = hexrgb("#b0623e")
RED = hexrgb("#b8402f")
YELLOW_PAINT = hexrgb("#d9a521")
BLUE_PAINT = hexrgb("#3d6f95")
GREEN_PAINT = hexrgb("#5b7f4a")
VISE = hexrgb("#4f6658")
COFFEE = hexrgb("#2b1a10")
MUG = hexrgb("#e9e4da")

# test bed
BED_BODY = hexrgb("#3b4146")
BED_TOP = hexrgb("#626a71")
BED_GROOVE = hexrgb("#2a2f33")
BED_TICK = hexrgb("#d9d4c6")

# jigs
JIG_STEEL = hexrgb("#41474d")
JIG_MACHINED = hexrgb("#a7adb2")
JIG_HATCH = hexrgb("#a9a597")
LOAD_YELLOW = hexrgb("#f2b705")
LOAD_BLACK = hexrgb("#1d1d1f")
CAST_IRON = hexrgb("#35383b")
HOSE = hexrgb("#151617")

# debris
CHIP = hexrgb("#b4b9be")
