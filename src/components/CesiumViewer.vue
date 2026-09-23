<template>
  <div id="map-container"></div>
</template>

<script setup>
import { onMounted } from 'vue'
import * as Cesium from 'cesium'
// Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN
onMounted(() => {
  const viewer = new Cesium.Viewer('map-container')
})
</script>

<style scoped>
#map-container {
  width: 100lvw;
  height: 100vh;
}
</style>
