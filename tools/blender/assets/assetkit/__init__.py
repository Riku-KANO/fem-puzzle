"""Helpers for the procedural environment assets (T-307).

Everything is authored in glTF space (Y-up, metres) and converted to Blender's Z-up frame
only when a Blender object is created (see `geo.GLTF_TO_BL`). The glTF exporter
(`export_yup=True`) applies the inverse, so the exported files are in the same frame the
asset scripts were written in.
"""
