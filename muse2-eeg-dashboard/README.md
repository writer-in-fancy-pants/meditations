# muse2-eeg-dashboard
Dashboard to compare sessions recorded with muselsl, using various neurofeedback metrics

## Run & Deploy
You can run a local server to compare your private files.
```
npm run build
npm run deploy
```

Alternatively, the same project has been deployed [here](https://writer-in-fancy-pants.github.io/muse2-eeg-dashboard) 
The website is serverless, running only in the browser. No files will leave your device.

## Converting other csv recordings
`python convert_to_muselsl.py -i <directory_of_csv_files/path_to_csv_file`

By default, the output will be saved in `./converted` which can be changed using
```
python convert_to_muselsl.py -i <directory_of_csv_files/path_to_csv_file> -o <output_directory>
```


## Supported devices
* Muse 2 recordings - muselsl / muselab / mind monitor
* Muse S Athena - muselsl / muselab mind monitor 

## Notes
* Make sure to record raw data at 256 HZ
* Now supported precomputed csv - channelwise frequency bands ie alpha_tp9, delta_af7, etc.
  * requires all channels (tp9, af7, af8, tp10), and all bands (delta, theta, alpha, beta, gamma)