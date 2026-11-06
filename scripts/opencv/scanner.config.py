# OpenCV.js export list for the scanner: only what src/ (and test/) call.
# Used by build.sh through build_js.py --config. Keep in sync when the
# pipeline starts using a new OpenCV function (the missing one will be
# `undefined` at runtime and the tests fail).

core = {
    '': [
        'absdiff', 'add', 'addWeighted', 'bitwise_and', 'bitwise_not', 'bitwise_or',
        'compare', 'convertScaleAbs', 'countNonZero', 'divide', 'inRange', 'magnitude',
        'max', 'mean', 'meanStdDev', 'merge', 'min', 'multiply', 'pow', 'rotate',
        'split', 'sqrt', 'subtract', 'LUT',
    ],
    # Base class of ORB / BFMatcher: without it they cannot be constructed.
    'Algorithm': [],
}

imgproc = {
    '': [
        'approxPolyDP', 'arcLength', 'boxFilter', 'Canny', 'circle',
        'connectedComponentsWithStats', 'contourArea', 'convexHull', 'cvtColor',
        'dilate', 'ellipse', 'erode', 'findContours', 'GaussianBlur',
        'getPerspectiveTransform', 'getStructuringElement', 'HoughLinesP',
        'Laplacian', 'line', 'medianBlur', 'morphologyEx', 'rectangle', 'remap',
        'resize', 'Sobel', 'threshold', 'warpPerspective',
    ],
}

video = {
    '': ['calcOpticalFlowFarneback'],
}

features2d = {
    'Feature2D': ['detect', 'compute', 'detectAndCompute', 'descriptorSize', 'descriptorType', 'defaultNorm', 'empty', 'getDefaultName'],
    'ORB': ['create', 'setMaxFeatures', 'getDefaultName'],
    'DescriptorMatcher': ['match', 'knnMatch', 'empty', 'clear', 'create'],
    'BFMatcher': ['isMaskSupported', 'create'],
}

calib3d = {
    '': ['findHomography'],
}

white_list = makeWhiteList([core, imgproc, video, features2d, calib3d])
