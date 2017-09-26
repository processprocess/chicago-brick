#!/bin/bash

# Replace this with a proper system tmp directory.
mkdir -p ./tmp

# Get the map data
curl -o 'tmp/ne_50m_admin_0_countries.zip' \
  'http://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_0_countries.zip'

curl -o 'tmp/ne_50m_lakes.zip' \
  'http://naciscdn.org/naturalearth/50m/physical/ne_50m_lakes.zip'

pushd tmp
unzip ne_50m_admin_0_countries.zip
unzip ne_50m_lakes.zip
popd

# Extract relavent features.
# Requires ogr2ogr part of the gdal framework.
# For mac, install 2.1 complete from http://www.kyngchaos.com/software:frameworks
/Library/Frameworks/GDAL.framework/Versions/Current/Programs/ogr2ogr \
  -f GeoJSON \
  -where "continent = 'North America' OR continent = 'South America'" \
  tmp/americas.json \
  tmp/ne_50m_admin_0_countries.shp

/Library/Frameworks/GDAL.framework/Versions/Current/Programs/ogr2ogr \
  -f GeoJSON \
  tmp/lakes.json \
  tmp/ne_50m_lakes.shp

# Copy to assets.
cp tmp/americas.json ../../../demo_assets
cp tmp/lakes.json ../../../demo_assets
