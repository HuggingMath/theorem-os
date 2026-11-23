import contourpy
import numpy as np

axis = np.linspace(-1, 1, 17)
x, y = np.meshgrid(axis, axis)
lines = contourpy.contour_generator(x=axis, y=axis, z=x + y).lines(0)
assert len(lines) == 1
coordinates = lines[0]
assert np.allclose(coordinates[:, 0] + coordinates[:, 1], 0)
print(f"{len(coordinates)} points on x + y = 0")
