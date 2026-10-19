---
name: blender-modeling
description: Use when modeling, texturing, lighting or rendering 3D scenes in Blender, including Blender Python scripts.
---

# Blender modeling and rendering

## Modeling

Start from simple primitives and build up with extrude, inset and loop cuts. Keep the modifier
stack non-destructive (mirror, subdivision surface, bevel) until the shape is final. Apply scale
with Ctrl+A before exporting.

## Materials and textures

Use the Principled BSDF shader. For metal, set Metallic to 1 and control shine with Roughness.
Unwrap UVs with Smart UV Project for quick results or mark seams for clean texture layouts.

## Lighting

A three-point setup uses a key light, a softer fill light on the other side and a rim light behind
the subject. Use an HDRI world texture for realistic ambient light and reflections.

## Rendering

Choose Cycles for accurate light and EEVEE for speed. Set the resolution in Output Properties,
enable denoising, and raise samples until noise is acceptable. Render a still with F12.

## Python scripting

Automate repetitive work with `bpy`. Select objects through `bpy.data.objects`, change modifiers
through `obj.modifiers`, and run scripts from the Scripting workspace.
